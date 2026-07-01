const USDC_DECIMALS = 6n;
const USDC_BASE = 10n ** USDC_DECIMALS;

export function normalizeUsdc(value: string | number | bigint): string {
  if (typeof value === "bigint") return baseUnitsToUsdc(value);
  const raw = String(value).trim();
  if (!/^\d+(\.\d{1,6})?$/.test(raw)) throw new Error(`Invalid USDC amount: ${raw}`);
  const parts = raw.split(".");
  const whole = parts[0] ?? "0";
  const fraction = parts[1] ?? "";
  const padded = fraction.padEnd(6, "0").slice(0, 6);
  const base = BigInt(whole) * USDC_BASE + BigInt(padded || "0");
  return baseUnitsToUsdc(base);
}

export function usdcToBaseUnits(value: string | number): bigint {
  const normalized = normalizeUsdc(value);
  const parts = normalized.split(".");
  const whole = parts[0] ?? "0";
  const fraction = parts[1] ?? "";
  return BigInt(whole) * USDC_BASE + BigInt(fraction.padEnd(6, "0"));
}

export function baseUnitsToUsdc(value: bigint | string | number): string {
  const units = typeof value === "bigint" ? value : BigInt(String(value));
  if (units < 0n) throw new Error(`Invalid negative USDC base units: ${units.toString()}`);
  const whole = units / USDC_BASE;
  const fraction = units % USDC_BASE;
  const fractionText = fraction.toString().padStart(6, "0").replace(/0+$/, "");
  return fractionText.length ? `${whole}.${fractionText}` : whole.toString();
}

export function addUsdc(a: string, b: string): string {
  return baseUnitsToUsdc(usdcToBaseUnits(a) + usdcToBaseUnits(b));
}

export function compareUsdc(a: string, b: string): number {
  const aa = usdcToBaseUnits(a);
  const bb = usdcToBaseUnits(b);
  return aa === bb ? 0 : aa > bb ? 1 : -1;
}

export function sumUsdc(values: string[]): string {
  return baseUnitsToUsdc(values.reduce((acc, value) => acc + usdcToBaseUnits(value), 0n));
}
