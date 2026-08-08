import { type ProviderConfig } from './config.js';
import { type Transport } from './transport.js';
import { FetchTransport } from './fetchTransport.js';
import { loadEgress, type EgressState } from './egress.js';
import { envelopeDecrypt } from './envelope.js';
import { CircuitBreaker } from './circuit.js';
import { Semaphore } from './semaphore.js';
import { ModelClient } from './client.js';
import { type ProviderHandle, type RequestRequirements as RouterRequirements } from './router.js';
import { type ModelCapabilities } from './probe/index.js';

/**
 * Provider registry: builds ProviderHandles from configs, decrypts keys (in
 * memory only), wires the transport, circuit, semaphore and egress state.
 */

export interface RegistryOptions {
  transport?: Transport;
  egress?: EgressState;
  masterKey?: Buffer | Uint8Array;
  /** capabilities keyed by `providerId|modelRef`. */
  capabilities?: Map<string, ModelCapabilities>;
  /** Providers that must be treated as egress-denied (air-gapped mode). */
  egressDenyProviders?: Set<string>;
}

export function capabilityKey(providerId: string, modelRef: string): string {
  return `${providerId}|${modelRef}`;
}

export class ProviderRegistry {
  private readonly transport: Transport;
  private readonly egress: EgressState;
  private readonly masterKey: Buffer | Uint8Array | undefined;
  private readonly capabilities: Map<string, ModelCapabilities>;
  private readonly egressDenyProviders: Set<string>;

  constructor(opts: RegistryOptions = {}) {
    this.transport = opts.transport ?? new FetchTransport({ egress: opts.egress });
    this.egress = opts.egress ?? loadEgress();
    this.masterKey = opts.masterKey;
    this.capabilities = opts.capabilities ?? new Map();
    this.egressDenyProviders = opts.egressDenyProviders ?? new Set();
  }

  /** Build a ProviderHandle. Capabilities are looked up by `providerId|modelRef`. */
  handle(cfg: ProviderConfig): ProviderHandle {
    const id = cfg.id;
    let key: string | undefined;
    if (cfg.keyCiphertext) {
      if (!this.masterKey) {
        throw new Error('KANAL_MASTER_KEY is required to decrypt provider keys');
      }
      const ct: Uint8Array =
        typeof cfg.keyCiphertext === 'string' ? Buffer.from(cfg.keyCiphertext, 'base64') : cfg.keyCiphertext;
      const dec = envelopeDecrypt(ct, this.masterKey, id);
      key = Buffer.from(dec).toString('utf8');
    }
    const decryptKey = () => key;
    const client = new ModelClient(cfg, this.transport, decryptKey);
    const circuit = new CircuitBreaker();
    const semaphore = new Semaphore(cfg.maxConcurrent);
    const capMap = this.capabilities;

    const handle: ProviderHandle = {
      id,
      cfg,
      circuit,
      semaphore,
      egressDenied: this.egressDenyProviders.has(id),
      client,
      satisfies(modelRef: string, req: RouterRequirements) {
        const caps = capMap.get(capabilityKey(id, modelRef));
        if (!caps) return true; // no probe data yet — let the call decide
        if (req.structuredOutput === 'required' && caps.structuredOutput === 'none') return false;
        if (
          req.minContextTokens !== undefined &&
          (caps.observedContextWindow ?? Infinity) < req.minContextTokens
        ) {
          return false;
        }
        return true;
      },
      async call(req) {
        await semaphore.acquire();
        try {
          return await client.complete(req);
        } finally {
          semaphore.release();
        }
      },
    };
    return handle;
  }

  buildRegistry(configs: ProviderConfig[]): Record<string, ProviderHandle> {
    const out: Record<string, ProviderHandle> = {};
    for (const cfg of configs) {
      out[cfg.id] = this.handle(cfg);
    }
    return out;
  }
}
