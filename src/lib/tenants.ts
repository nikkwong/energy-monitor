import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export const TENANT_ID_RE = /^[\p{L}\p{N}_-]{1,32}$/u;

export type TenantModalities = {
  power: boolean;
  water: boolean;
};

export type TenantConfig = {
  tenantId: string;
  label: string;
  modalities: TenantModalities;
};

export type TenantsConfig = {
  schemaVersion: 1;
  defaultTenantId: string;
  tenants: TenantConfig[];
};

export const DATA_DIR = resolve(process.env.DATA_DIR ?? resolve(process.cwd(), "data"));
export const TENANTS_PATH = resolve(DATA_DIR, "tenants.json");
const REPO_TENANTS_PATH = resolve(process.cwd(), "data", "tenants.json");

let cachedConfig: TenantsConfig | null = null;

function invalid(message: string): never {
  throw new Error(`invalid tenants.json: ${message}`);
}

function parseTenant(value: unknown, index: number): TenantConfig {
  if (!value || typeof value !== "object") invalid(`tenants[${index}] must be an object`);
  const raw = value as Record<string, unknown>;
  if (typeof raw["tenantId"] !== "string" || !TENANT_ID_RE.test(raw["tenantId"])) {
    invalid(`tenants[${index}].tenantId must be a safe path segment`);
  }
  if (typeof raw["label"] !== "string" || !raw["label"].trim()) {
    invalid(`tenants[${index}].label must be a non-empty string`);
  }
  const modalities = raw["modalities"];
  if (!modalities || typeof modalities !== "object") {
    invalid(`tenants[${index}].modalities must be an object`);
  }
  const m = modalities as Record<string, unknown>;
  if (typeof m["power"] !== "boolean" || typeof m["water"] !== "boolean") {
    invalid(`tenants[${index}].modalities must contain boolean power and water fields`);
  }
  return {
    tenantId: raw["tenantId"],
    label: raw["label"].trim(),
    modalities: { power: m["power"], water: m["water"] },
  };
}

export function validateTenantsConfig(value: unknown): TenantsConfig {
  if (!value || typeof value !== "object") invalid("root must be an object");
  const raw = value as Record<string, unknown>;
  if (raw["schemaVersion"] !== 1) invalid("schemaVersion must be 1");
  if (!Array.isArray(raw["tenants"]) || raw["tenants"].length === 0) {
    invalid("tenants must be a non-empty array");
  }
  const tenants = raw["tenants"].map(parseTenant);
  const ids = new Set<string>();
  for (const tenant of tenants) {
    if (ids.has(tenant.tenantId)) invalid(`duplicate tenantId "${tenant.tenantId}"`);
    ids.add(tenant.tenantId);
  }
  const defaultTenantId = raw["defaultTenantId"];
  if (typeof defaultTenantId !== "string" || !ids.has(defaultTenantId)) {
    invalid("defaultTenantId must identify a configured tenant");
  }
  return { schemaVersion: 1, defaultTenantId, tenants };
}

export async function loadTenantsConfig(): Promise<TenantsConfig> {
  if (cachedConfig) return cachedConfig;
  let loadedPath = TENANTS_PATH;
  try {
    let text: string;
    try {
      text = await readFile(TENANTS_PATH, "utf8");
    } catch (err) {
      if (
        (err as NodeJS.ErrnoException).code === "ENOENT" &&
        TENANTS_PATH !== REPO_TENANTS_PATH
      ) {
        loadedPath = REPO_TENANTS_PATH;
        text = await readFile(REPO_TENANTS_PATH, "utf8");
      } else {
        throw err;
      }
    }
    cachedConfig = validateTenantsConfig(JSON.parse(text));
    return cachedConfig;
  } catch (err) {
    throw new Error(
      `failed to load tenant registry at ${loadedPath}: ${
        err instanceof Error ? err.message : String(err)
      }`,
      { cause: err },
    );
  }
}

export async function getTenant(tenantId: string): Promise<TenantConfig | null> {
  if (!TENANT_ID_RE.test(tenantId)) return null;
  const cfg = await loadTenantsConfig();
  return cfg.tenants.find((tenant) => tenant.tenantId === tenantId) ?? null;
}

export async function requireTenant(tenantId: string): Promise<TenantConfig> {
  const tenant = await getTenant(tenantId);
  if (!tenant) throw new Error(`unknown tenant "${tenantId}"`);
  return tenant;
}

export function clearTenantsConfigCache(): void {
  cachedConfig = null;
}
