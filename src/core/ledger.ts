import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import type { LedgerPaymentRecord, SpendLedger } from "./types.js";
import { addUsdc, compareUsdc, sumUsdc } from "../utils/money.js";
import { PolicyViolation } from "./errors.js";

interface LedgerFile {
  payments: LedgerPaymentRecord[];
}

const ACTIVE_SPEND_STATUSES = new Set(["reserved", "success"]);

function dayFromIso(iso: string): string {
  return iso.slice(0, 10);
}

function activeSpendFor(file: LedgerFile, walletAddress: string, dayIso: string): string {
  const day = dayIso.slice(0, 10);
  const wallet = walletAddress.toLowerCase();
  return file.payments
    .filter((p) => p.walletAddress.toLowerCase() === wallet && dayFromIso(p.createdAt) === day && ACTIVE_SPEND_STATUSES.has(p.status))
    .reduce((acc, payment) => addUsdc(acc, payment.amountUsdc), "0");
}

function upsertPayment(payments: LedgerPaymentRecord[], record: LedgerPaymentRecord): LedgerPaymentRecord[] {
  const index = payments.findIndex((payment) => payment.id === record.id);
  if (index === -1) return [...payments, record];
  const next = payments.slice();
  next[index] = { ...payments[index], ...record };
  return next;
}

export class InMemorySpendLedger implements SpendLedger {
  private payments: LedgerPaymentRecord[] = [];
  private mutex: Promise<void> = Promise.resolve();

  private async withMutex<T>(fn: () => Promise<T> | T): Promise<T> {
    const previous = this.mutex;
    let release!: () => void;
    this.mutex = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  async getDailySpend(walletAddress: string, dayIso: string): Promise<string> {
    return this.withMutex(() => activeSpendFor({ payments: this.payments }, walletAddress, dayIso));
  }

  async recordPayment(record: LedgerPaymentRecord): Promise<void> {
    await this.withMutex(() => {
      this.payments = upsertPayment(this.payments, record);
    });
  }

  async reservePayment(record: LedgerPaymentRecord, dailyBudgetUsdc: string, dayIso: string): Promise<void> {
    await this.withMutex(() => {
      const activeSpend = activeSpendFor({ payments: this.payments }, record.walletAddress, dayIso);
      const total = sumUsdc([activeSpend, record.amountUsdc]);
      if (compareUsdc(total, dailyBudgetUsdc) > 0) {
        throw new PolicyViolation(`Daily budget exceeded: spent_or_reserved=${activeSpend}, planned=${record.amountUsdc}, limit=${dailyBudgetUsdc} USDC`);
      }
      this.payments = upsertPayment(this.payments, { ...record, status: "reserved" });
    });
  }
}

export class FileSpendLedger implements SpendLedger {
  constructor(private readonly path = ".x402-ledger.json", private readonly lockTimeoutMs = 5000) {}

  private async load(): Promise<LedgerFile> {
    try {
      const raw = await readFile(this.path, "utf8");
      const parsed = JSON.parse(raw) as LedgerFile;
      return { payments: Array.isArray(parsed.payments) ? parsed.payments : [] };
    } catch (error: any) {
      if (error?.code === "ENOENT") return { payments: [] };
      throw error;
    }
  }

  private async save(file: LedgerFile): Promise<void> {
    const dir = dirname(this.path);
    if (dir && dir !== ".") await mkdir(dir, { recursive: true });
    const tmp = `${this.path}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
    await writeFileCompat(tmp, JSON.stringify(file, null, 2));
    await rename(tmp, this.path);
  }

  private async withFileLock<T>(fn: () => Promise<T>): Promise<T> {
    const dir = dirname(this.path);
    if (dir && dir !== ".") await mkdir(dir, { recursive: true });
    const lockPath = `${this.path}.lock`;
    const deadline = Date.now() + this.lockTimeoutMs;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    while (!handle) {
      try {
        handle = await open(lockPath, "wx", 0o600);
      } catch (error: any) {
        if (error?.code !== "EEXIST" || Date.now() >= deadline) throw error;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    try {
      return await fn();
    } finally {
      await handle.close().catch(() => undefined);
      await unlink(lockPath).catch(() => undefined);
    }
  }

  async getDailySpend(walletAddress: string, dayIso: string): Promise<string> {
    return this.withFileLock(async () => activeSpendFor(await this.load(), walletAddress, dayIso));
  }

  async recordPayment(record: LedgerPaymentRecord): Promise<void> {
    await this.withFileLock(async () => {
      const file = await this.load();
      file.payments = upsertPayment(file.payments, record);
      await this.save(file);
    });
  }

  async reservePayment(record: LedgerPaymentRecord, dailyBudgetUsdc: string, dayIso: string): Promise<void> {
    await this.withFileLock(async () => {
      const file = await this.load();
      const activeSpend = activeSpendFor(file, record.walletAddress, dayIso);
      const total = sumUsdc([activeSpend, record.amountUsdc]);
      if (compareUsdc(total, dailyBudgetUsdc) > 0) {
        throw new PolicyViolation(`Daily budget exceeded: spent_or_reserved=${activeSpend}, planned=${record.amountUsdc}, limit=${dailyBudgetUsdc} USDC`);
      }
      file.payments = upsertPayment(file.payments, { ...record, status: "reserved" });
      await this.save(file);
    });
  }
}

async function writeFileCompat(path: string, data: string): Promise<void> {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(path, data, { mode: 0o600 });
}
