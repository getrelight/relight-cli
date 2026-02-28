var MSG = "SlicerVM does not include managed databases. Use an external database service.";

export async function createDatabase() {
  throw new Error(MSG);
}

export async function destroyDatabase() {
  throw new Error(MSG);
}

export async function getDatabaseInfo() {
  throw new Error(MSG);
}

export async function queryDatabase() {
  throw new Error(MSG);
}

export async function importDatabase() {
  throw new Error(MSG);
}

export async function exportDatabase() {
  throw new Error(MSG);
}

export async function rotateToken() {
  throw new Error(MSG);
}

export async function resetDatabase() {
  throw new Error(MSG);
}
