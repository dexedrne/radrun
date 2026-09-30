// The relayer queue (docs/WAGER.md §4.3): the only sender for its key, so nonces never collide. One transaction at a
// time is estimated (which is also the last simulation: a revert costs nothing), signed locally and sent with the
// next local nonce; receipts are polled every 250 ms for up to 30 s. Any send error resyncs the nonce from `pending`.
// The lobby runs one for RELAYER_KEY (openSession, lock, settle) and one for FAUCET_KEY on test networks.
import type { Address, Hex } from "viem";
import { revertReason, type Call, type Receipt, type TxRpc } from "./chain.ts";

/** What the queue needs of an account: viem's privateKeyToAccount() is one. */
export type TxSigner = {
  address: Address;
  signTransaction(tx: {
    type: "eip1559"; chainId: number; nonce: number; to: Address; data: Hex; value: bigint; gas: bigint; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint;
  }): Promise<Hex>;
};

export type TxOutcome = Receipt | { status: "timeout" };
export type TxHandle = { hash: Hex; done: Promise<TxOutcome> };

export class TxError extends Error {}

export class Relayer {
  readonly address: Address;
  private readonly rpc: TxRpc;
  private readonly signer: TxSigner;
  private readonly chainId: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly pollMs: number;
  private readonly timeoutMs: number;
  private nonce: number | null = null;
  private tail: Promise<unknown> = Promise.resolve();
  sent = 0;
  resyncs = 0;

  constructor(o: { rpc: TxRpc; signer: TxSigner; chainId: number; sleep?: (ms: number) => Promise<void>; pollMs?: number; timeoutMs?: number }) {
    this.rpc = o.rpc;
    this.signer = o.signer;
    this.address = o.signer.address;
    this.chainId = o.chainId;
    this.sleep = o.sleep ?? (ms => new Promise(r => setTimeout(r, ms)));
    this.pollMs = o.pollMs ?? 250;
    this.timeoutMs = o.timeoutMs ?? 30_000;
  }

  /** Queue a transaction. Resolves once it is sent (with its receipt promise); rejects (TxError) if it would revert or the send fails. */
  submit(call: Call): Promise<TxHandle> {
    const p = this.tail.then(() => this.sendOne(call));
    this.tail = p.catch(() => {});
    return p;
  }

  private async sendOne(call: Call): Promise<TxHandle> {
    let gas: bigint;
    try {
      gas = await this.rpc.estimateGas(this.address, call);
    } catch (e) {
      throw new TxError(revertReason(e));
    }
    gas = (gas * 12n) / 10n + 10_000n;
    try {
      if (this.nonce === null) this.nonce = await this.rpc.nonce(this.address);
      const fees = await this.rpc.fees();
      const signed = await this.signer.signTransaction({
        type: "eip1559", chainId: this.chainId, nonce: this.nonce, to: call.to, data: call.data, value: call.value ?? 0n, gas, ...fees,
      });
      const hash = await this.rpc.sendRaw(signed);
      this.nonce++;
      this.sent++;
      return { hash, done: this.wait(hash) };
    } catch (e) {
      this.nonce = null;
      this.resyncs++;
      throw new TxError(revertReason(e));
    }
  }

  private async wait(hash: Hex): Promise<TxOutcome> {
    for (let t = 0; t < this.timeoutMs; t += this.pollMs) {
      const r = await this.rpc.receipt(hash).catch(() => null);
      if (r) return r;
      await this.sleep(this.pollMs);
    }
    // A transaction that never lands may leave a nonce gap: take the chain's word for the next one.
    this.nonce = null;
    this.resyncs++;
    return { status: "timeout" };
  }
}
