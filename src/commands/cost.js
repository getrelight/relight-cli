import { phase, status, fatal, fmt, table } from "../lib/output.js";
import { resolveAppName } from "../lib/link.js";
import { resolveTarget } from "../lib/providers/resolve.js";

// --- Pricing (Workers Paid plan, $5/mo) ---

var CF_PRICING = {
  workerRequests: { included: 10_000_000, rate: 0.30 / 1_000_000 },
  workerCpuMs: { included: 30_000_000, rate: 0.02 / 1_000_000 },
  doRequests: { included: 1_000_000, rate: 0.15 / 1_000_000 },
  doGbSeconds: { included: 400_000, rate: 12.50 / 1_000_000 },
  containerVcpuSec: { included: 375 * 60, rate: 0.000020 },
  containerMemGibSec: { included: 25 * 3600, rate: 0.0000025 },
  containerDiskGbSec: { included: 200 * 3600, rate: 0.00000007 },
  containerEgressGb: { included: 0, rate: 0.025 },
  platform: 5.0,
};

// --- GCP Cloud Run pricing ---

var GCP_PRICING = {
  vcpuSecond: 0.00002400,
  memGibSecond: 0.00000250,
  requestsFree: 2_000_000,
  requestRate: 0.40 / 1_000_000,
};

// --- AWS App Runner pricing ---

var AWS_PRICING = {
  activeVcpuHr: 0.064,
  provisionedVcpuHr: 0.007,
  memGbHr: 0.007,
};

// --- Date range parsing ---

function parseDateRange(since) {
  var now = new Date();
  var until = now;
  var start;

  if (!since) {
    start = new Date(now.getFullYear(), now.getMonth(), 1);
  } else if (/^\d+d$/.test(since)) {
    var days = parseInt(since);
    start = new Date(now.getTime() - days * 86400_000);
  } else if (/^\d{4}-\d{2}-\d{2}$/.test(since)) {
    start = new Date(since + "T00:00:00Z");
    if (isNaN(start.getTime())) {
      fatal(`Invalid date: ${since}`, "Use YYYY-MM-DD or Nd (e.g. 7d)");
    }
  } else {
    fatal(
      `Invalid --since value: ${since}`,
      "Use YYYY-MM-DD or Nd (e.g. 7d, 30d)"
    );
  }

  var sinceISO = start.toISOString().slice(0, 19) + "Z";
  var untilISO = until.toISOString().slice(0, 19) + "Z";

  var label = formatDateRange(start, until);
  return { sinceISO, untilISO, sinceDate: start, untilDate: until, label };
}

function formatDateRange(start, end) {
  var opts = { month: "short", day: "numeric" };
  var s = start.toLocaleDateString("en-US", opts);
  var e = end.toLocaleDateString("en-US", opts);
  return `${s} - ${e}`;
}

// --- CF cost calculation ---

function calculateAppCosts(usage) {
  return {
    workerRequests: usage.workerRequests * CF_PRICING.workerRequests.rate,
    workerCpuMs: usage.workerCpuMs * CF_PRICING.workerCpuMs.rate,
    doRequests: usage.doRequests * CF_PRICING.doRequests.rate,
    doGbSeconds: usage.doGbSeconds * CF_PRICING.doGbSeconds.rate,
    containerVcpuSec: usage.containerVcpuSec * CF_PRICING.containerVcpuSec.rate,
    containerMemGibSec: usage.containerMemGibSec * CF_PRICING.containerMemGibSec.rate,
    containerDiskGbSec: usage.containerDiskGbSec * CF_PRICING.containerDiskGbSec.rate,
    containerEgressGb: usage.containerEgressGb * CF_PRICING.containerEgressGb.rate,
  };
}

function applyFreeTier(appResults) {
  var totals = {
    workerRequests: 0,
    workerCpuMs: 0,
    doRequests: 0,
    doGbSeconds: 0,
    containerVcpuSec: 0,
    containerMemGibSec: 0,
    containerDiskGbSec: 0,
    containerEgressGb: 0,
  };
  for (var app of appResults) {
    for (var key of Object.keys(totals)) {
      totals[key] += app.usage[key];
    }
  }

  var fleetOverage = {};
  for (var key of Object.keys(totals)) {
    var included = CF_PRICING[key].included;
    var overageUsage = Math.max(0, totals[key] - included);
    fleetOverage[key] = overageUsage * CF_PRICING[key].rate;
  }

  var grossFleetTotal = 0;
  for (var app of appResults) {
    var costs = calculateAppCosts(app.usage);
    app.grossCosts = costs;
    var appGross = Object.values(costs).reduce((a, b) => a + b, 0);
    app.grossTotal = appGross;
    grossFleetTotal += appGross;
  }

  var netFleetTotal = Object.values(fleetOverage).reduce((a, b) => a + b, 0);
  var freeTierDiscount = grossFleetTotal - netFleetTotal;

  for (var app of appResults) {
    if (grossFleetTotal > 0) {
      var share = app.grossTotal / grossFleetTotal;
      app.freeTierDiscount = freeTierDiscount * share;
    } else {
      app.freeTierDiscount = 0;
    }
    app.netTotal = Math.max(0, app.grossTotal - app.freeTierDiscount);

    app.workersCost = app.grossCosts.workerRequests + app.grossCosts.workerCpuMs;
    app.doCost = app.grossCosts.doRequests + app.grossCosts.doGbSeconds;
    app.containerCost =
      app.grossCosts.containerVcpuSec +
      app.grossCosts.containerMemGibSec +
      app.grossCosts.containerDiskGbSec +
      app.grossCosts.containerEgressGb;
  }

  return { appResults, freeTierDiscount, netFleetTotal, grossFleetTotal };
}

// --- GCP cost calculation ---

function calculateGcpAppCosts(usage) {
  var cpuCost = usage.cpuSeconds * GCP_PRICING.vcpuSecond;
  var memCost = usage.memGibSeconds * GCP_PRICING.memGibSecond;
  var billableRequests = Math.max(0, usage.requests - GCP_PRICING.requestsFree);
  var requestCost = billableRequests * GCP_PRICING.requestRate;
  return { cpuCost, memCost, requestCost, total: cpuCost + memCost + requestCost };
}

// --- Formatting helpers ---

function fmtCost(n) {
  return "$" + n.toFixed(2);
}

function fmtUsage(n, unit) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M " + unit;
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K " + unit;
  return n.toLocaleString("en-US") + " " + unit;
}

function fmtDuration(seconds) {
  var hrs = seconds / 3600;
  if (hrs >= 1) return hrs.toFixed(1) + " vCPU-hrs";
  var mins = seconds / 60;
  return mins.toFixed(1) + " vCPU-min";
}

function fmtGibHours(gibSec) {
  var hrs = gibSec / 3600;
  if (hrs >= 1) return hrs.toFixed(1) + " GiB-hrs";
  var mins = gibSec / 60;
  return mins.toFixed(1) + " GiB-min";
}

function fmtGbHours(gbSec) {
  var hrs = gbSec / 3600;
  if (hrs >= 1) return hrs.toFixed(1) + " GB-hrs";
  var mins = gbSec / 60;
  return mins.toFixed(1) + " GB-min";
}

// --- Render CF single app ---

function renderCfSingleApp(app, range) {
  console.log("");
  console.log(
    `  ${fmt.bold("Estimated cost for")} ${fmt.app(app.name)} ${fmt.dim(`(${range.label})`)}`
  );
  console.log("");

  var header = "  COMPONENT      USAGE                 ESTIMATED COST";
  var sep = "  " + "-".repeat(50);

  console.log(fmt.bold(header));
  console.log(fmt.dim(sep));

  var rows = [
    ["Workers", fmtUsage(app.usage.workerRequests, "requests"), fmtCost(app.grossCosts.workerRequests)],
    ["", fmtUsage(app.usage.workerCpuMs, "CPU-ms"), fmtCost(app.grossCosts.workerCpuMs)],
    ["Durable Obj", fmtUsage(app.usage.doRequests, "requests"), fmtCost(app.grossCosts.doRequests)],
    app.usage.doWsMsgs > 0
      ? ["", fmtUsage(app.usage.doWsMsgs, "WS msgs") + fmt.dim(" (20:1)"), ""]
      : null,
    ["", fmtUsage(app.usage.doGbSeconds, "GB-s"), fmtCost(app.grossCosts.doGbSeconds)],
    ["Containers", fmtDuration(app.usage.containerVcpuSec), fmtCost(app.grossCosts.containerVcpuSec)],
    ["", fmtGibHours(app.usage.containerMemGibSec) + " mem", fmtCost(app.grossCosts.containerMemGibSec)],
    ["", fmtGbHours(app.usage.containerDiskGbSec) + " disk", fmtCost(app.grossCosts.containerDiskGbSec)],
    ["", fmtUsage(app.usage.containerEgressGb, "GB egress"), fmtCost(app.grossCosts.containerEgressGb)],
  ];

  for (var row of rows.filter(Boolean)) {
    var comp = row[0] ? fmt.bold(row[0].padEnd(14)) : " ".repeat(14);
    var usage = row[1].padEnd(22);
    console.log(`  ${comp} ${usage} ${row[2]}`);
  }

  console.log(fmt.dim(sep));
  console.log(
    `  ${" ".repeat(14)} ${"".padEnd(22)} ${fmt.bold(fmtCost(app.grossTotal))}`
  );

  if (app.freeTierDiscount > 0) {
    console.log(
      `  ${" ".repeat(14)} ${fmt.dim("Free tier".padEnd(22))} ${fmt.dim("-" + fmtCost(app.freeTierDiscount))}`
    );
    console.log(
      `  ${" ".repeat(14)} ${fmt.bold("Net".padEnd(22))} ${fmt.bold(fmtCost(app.netTotal))}`
    );
  }

  console.log("");
  console.log(fmt.dim("  Estimates based on Cloudflare Workers Paid plan pricing."));
  console.log("");
}

// --- Render CF fleet ---

function renderCfFleet(fleet, range) {
  console.log("");
  console.log(
    `  ${fmt.bold("Estimated costs")} ${fmt.dim(`(${range.label})`)}`
  );
  console.log("");

  var headers = ["NAME", "WORKERS", "DO", "CONTAINERS", "TOTAL"];
  var rows = fleet.appResults.map((a) => [
    fmt.app(a.name),
    fmtCost(a.workersCost),
    fmtCost(a.doCost),
    fmtCost(a.containerCost),
    fmtCost(a.grossTotal),
  ]);

  console.log(table(headers, rows));
  console.log("");

  var labelW = 44;
  console.log(
    "  " + fmt.dim("Subtotal".padEnd(labelW)) + fmtCost(fleet.grossFleetTotal)
  );
  if (fleet.freeTierDiscount > 0) {
    console.log(
      "  " +
        fmt.dim("Free tier".padEnd(labelW)) +
        fmt.dim("-" + fmtCost(fleet.freeTierDiscount))
    );
  }
  console.log(
    "  " + fmt.dim("Platform".padEnd(labelW)) + fmtCost(CF_PRICING.platform)
  );
  console.log("  " + fmt.dim("-".repeat(labelW + 8)));
  console.log(
    "  " +
      fmt.bold("TOTAL".padEnd(labelW)) +
      fmt.bold(fmtCost(fleet.netFleetTotal + CF_PRICING.platform))
  );
  console.log("");
  console.log(fmt.dim("  Estimates based on Cloudflare Workers Paid plan pricing."));
  console.log("");
}

// --- Render GCP single app ---

function renderGcpSingleApp(app, range) {
  var costs = calculateGcpAppCosts(app.usage);

  console.log("");
  console.log(
    `  ${fmt.bold("Estimated cost for")} ${fmt.app(app.name)} ${fmt.dim(`(${range.label})`)}`
  );
  console.log("");

  var header = "  COMPONENT      USAGE                 ESTIMATED COST";
  var sep = "  " + "-".repeat(50);

  console.log(fmt.bold(header));
  console.log(fmt.dim(sep));

  var rows = [
    ["CPU", fmtDuration(app.usage.cpuSeconds), fmtCost(costs.cpuCost)],
    ["Memory", fmtGibHours(app.usage.memGibSeconds), fmtCost(costs.memCost)],
    ["Requests", fmtUsage(app.usage.requests, "requests"), fmtCost(costs.requestCost)],
  ];

  for (var row of rows) {
    var comp = row[0] ? fmt.bold(row[0].padEnd(14)) : " ".repeat(14);
    var usage = row[1].padEnd(22);
    console.log(`  ${comp} ${usage} ${row[2]}`);
  }

  console.log(fmt.dim(sep));
  console.log(
    `  ${" ".repeat(14)} ${"".padEnd(22)} ${fmt.bold(fmtCost(costs.total))}`
  );

  if (app.usage.requests <= GCP_PRICING.requestsFree) {
    console.log(
      `  ${" ".repeat(14)} ${fmt.dim("2M free requests/mo".padEnd(22))}`
    );
  }

  console.log("");
  console.log(fmt.dim("  Estimates based on GCP Cloud Run pricing."));
  console.log("");
}

// --- Render GCP fleet ---

function renderGcpFleet(appResults, range) {
  console.log("");
  console.log(
    `  ${fmt.bold("Estimated costs")} ${fmt.dim(`(${range.label})`)}`
  );
  console.log("");

  var headers = ["NAME", "CPU", "MEMORY", "REQUESTS", "TOTAL"];
  var rows = appResults.map((a) => {
    var costs = calculateGcpAppCosts(a.usage);
    return [
      fmt.app(a.name),
      fmtCost(costs.cpuCost),
      fmtCost(costs.memCost),
      fmtCost(costs.requestCost),
      fmtCost(costs.total),
    ];
  });

  console.log(table(headers, rows));
  console.log("");

  var grandTotal = appResults.reduce((sum, a) => sum + calculateGcpAppCosts(a.usage).total, 0);
  var labelW = 44;
  console.log("  " + fmt.dim("-".repeat(labelW + 8)));
  console.log(
    "  " +
      fmt.bold("TOTAL".padEnd(labelW)) +
      fmt.bold(fmtCost(grandTotal))
  );
  console.log("");
  console.log(fmt.dim("  Estimates based on GCP Cloud Run pricing."));
  console.log("");
}

// --- AWS cost calculation ---

function calculateAwsAppCosts(usage) {
  var activeCost = usage.activeVcpuHrs * AWS_PRICING.activeVcpuHr;
  var provisionedCost = usage.provisionedVcpuHrs * AWS_PRICING.provisionedVcpuHr;
  var memCost = usage.memGbHrs * AWS_PRICING.memGbHr;
  return { activeCost, provisionedCost, memCost, total: activeCost + provisionedCost + memCost };
}

// --- Render AWS single app ---

function renderAwsSingleApp(app, range) {
  var costs = calculateAwsAppCosts(app.usage);

  console.log("");
  console.log(
    `  ${fmt.bold("Estimated cost for")} ${fmt.app(app.name)} ${fmt.dim(`(${range.label})`)}`
  );
  console.log("");

  var header = "  COMPONENT      USAGE                 ESTIMATED COST";
  var sep = "  " + "-".repeat(50);

  console.log(fmt.bold(header));
  console.log(fmt.dim(sep));

  var rows = [
    ["Active vCPU", app.usage.activeVcpuHrs.toFixed(1) + " vCPU-hrs", fmtCost(costs.activeCost)],
    ["Provisioned", app.usage.provisionedVcpuHrs.toFixed(1) + " vCPU-hrs", fmtCost(costs.provisionedCost)],
    ["Memory", app.usage.memGbHrs.toFixed(1) + " GB-hrs", fmtCost(costs.memCost)],
  ];

  for (var row of rows) {
    var comp = row[0] ? fmt.bold(row[0].padEnd(14)) : " ".repeat(14);
    var usage = row[1].padEnd(22);
    console.log(`  ${comp} ${usage} ${row[2]}`);
  }

  console.log(fmt.dim(sep));
  console.log(
    `  ${" ".repeat(14)} ${"".padEnd(22)} ${fmt.bold(fmtCost(costs.total))}`
  );

  console.log("");
  console.log(fmt.dim("  Estimates based on AWS App Runner pricing (min 1 provisioned instance)."));
  console.log("");
}

// --- Render AWS fleet ---

function renderAwsFleet(appResults, range) {
  console.log("");
  console.log(
    `  ${fmt.bold("Estimated costs")} ${fmt.dim(`(${range.label})`)}`
  );
  console.log("");

  var headers = ["NAME", "ACTIVE", "PROVISIONED", "MEMORY", "TOTAL"];
  var rows = appResults.map((a) => {
    var costs = calculateAwsAppCosts(a.usage);
    return [
      fmt.app(a.name),
      fmtCost(costs.activeCost),
      fmtCost(costs.provisionedCost),
      fmtCost(costs.memCost),
      fmtCost(costs.total),
    ];
  });

  console.log(table(headers, rows));
  console.log("");

  var grandTotal = appResults.reduce((sum, a) => sum + calculateAwsAppCosts(a.usage).total, 0);
  var labelW = 44;
  console.log("  " + fmt.dim("-".repeat(labelW + 8)));
  console.log(
    "  " +
      fmt.bold("TOTAL".padEnd(labelW)) +
      fmt.bold(fmtCost(grandTotal))
  );
  console.log("");
  console.log(fmt.dim("  Estimates based on AWS App Runner pricing (min 1 provisioned instance)."));
  console.log("");
}

// --- Main command ---

export async function cost(name, options) {
  var target = await resolveTarget(options);
  var cfg = target.cfg;
  var appProvider = await target.provider("app");

  var range = parseDateRange(options.since);

  var singleApp = name ? resolveAppName(name) : null;

  phase("Fetching analytics");
  status("Querying...");

  var appNames = singleApp ? [singleApp] : null;
  var appResults = await appProvider.getCosts(cfg, appNames, range);

  if (appResults.length === 0) {
    fatal(
      "No apps deployed.",
      `Run ${fmt.cmd("relight deploy")} to deploy your first app.`
    );
  }

  if (target.type === "aws") {
    // AWS rendering
    if (options.json) {
      var jsonOut = singleApp
        ? {
            app: appResults[0].name,
            period: range.label,
            since: range.sinceISO,
            until: range.untilISO,
            usage: appResults[0].usage,
            costs: calculateAwsAppCosts(appResults[0].usage),
          }
        : {
            period: range.label,
            since: range.sinceISO,
            until: range.untilISO,
            apps: appResults.map((a) => ({
              name: a.name,
              usage: a.usage,
              costs: calculateAwsAppCosts(a.usage),
            })),
            total: appResults.reduce((s, a) => s + calculateAwsAppCosts(a.usage).total, 0),
          };
      console.log(JSON.stringify(jsonOut, null, 2));
      return;
    }

    if (singleApp) {
      renderAwsSingleApp(appResults[0], range);
    } else {
      renderAwsFleet(appResults, range);
    }
    return;
  }

  if (target.type === "gcp") {
    // GCP rendering
    if (options.json) {
      var jsonOut = singleApp
        ? {
            app: appResults[0].name,
            period: range.label,
            since: range.sinceISO,
            until: range.untilISO,
            usage: appResults[0].usage,
            costs: calculateGcpAppCosts(appResults[0].usage),
          }
        : {
            period: range.label,
            since: range.sinceISO,
            until: range.untilISO,
            apps: appResults.map((a) => ({
              name: a.name,
              usage: a.usage,
              costs: calculateGcpAppCosts(a.usage),
            })),
            total: appResults.reduce((s, a) => s + calculateGcpAppCosts(a.usage).total, 0),
          };
      console.log(JSON.stringify(jsonOut, null, 2));
      return;
    }

    if (singleApp) {
      renderGcpSingleApp(appResults[0], range);
    } else {
      renderGcpFleet(appResults, range);
    }
    return;
  }

  // CF rendering
  var fleet = applyFreeTier(appResults);

  if (options.json) {
    var jsonOut = singleApp
      ? {
          app: fleet.appResults[0].name,
          period: range.label,
          since: range.sinceISO,
          until: range.untilISO,
          usage: fleet.appResults[0].usage,
          costs: fleet.appResults[0].grossCosts,
          grossTotal: fleet.appResults[0].grossTotal,
          freeTierDiscount: fleet.appResults[0].freeTierDiscount,
          netTotal: fleet.appResults[0].netTotal,
        }
      : {
          period: range.label,
          since: range.sinceISO,
          until: range.untilISO,
          apps: fleet.appResults.map((a) => ({
            name: a.name,
            usage: a.usage,
            costs: a.grossCosts,
            grossTotal: a.grossTotal,
            freeTierDiscount: a.freeTierDiscount,
            netTotal: a.netTotal,
          })),
          grossFleetTotal: fleet.grossFleetTotal,
          freeTierDiscount: fleet.freeTierDiscount,
          netFleetTotal: fleet.netFleetTotal,
          platform: CF_PRICING.platform,
          total: fleet.netFleetTotal + CF_PRICING.platform,
        };
    console.log(JSON.stringify(jsonOut, null, 2));
    return;
  }

  if (singleApp) {
    renderCfSingleApp(fleet.appResults[0], range);
  } else {
    renderCfFleet(fleet, range);
  }
}
