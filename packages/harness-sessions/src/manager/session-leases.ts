import type { SessionClaim, SessionStore } from '../definitions/store.js';

type Report = (action: string, sessionId?: string) => (error: unknown) => void;

/** How often a manager renews its lease: three times within its life. */
const RENEWALS_PER_LEASE = 3;

/** The methods of a store that shares its sessions between managers. */
type LeasingStore = Pick<SessionStore<unknown>, 'claimSession' | 'releaseSession' | 'renewLease'>;

export interface SessionLeasesOptions {
  store: LeasingStore;
  /** This manager. */
  owner: string;
  ttlMs: number;
  report: Report;
}

/** Whether the store gives its lease methods: all three, or none. */
function sharesSessions(store: LeasingStore): boolean {
  const given = [
    typeof store.claimSession,
    typeof store.renewLease,
    typeof store.releaseSession,
  ].filter((type) => type === 'function').length;
  if (given !== 0 && given !== 3) {
    throw new TypeError(
      'A session store shares its sessions with claimSession, renewLease and releaseSession, all three.',
    );
  }
  return given === 3;
}

/**
 * The sessions a manager holds in a store it shares with other managers, and its lease that
 * keeps them: renewed in the background, checked by the store when another manager claims one. A
 * store without leases has one manager: every claim succeeds, and nothing is renewed.
 */
export class SessionLeases {
  readonly owner: string;
  /** Whether the store shares its sessions between managers. */
  readonly shared: boolean;
  private readonly store: LeasingStore;
  private readonly ttlMs: number;
  private readonly report: Report;
  private renewal: NodeJS.Timeout | undefined;

  constructor({ store, owner, ttlMs, report }: SessionLeasesOptions) {
    this.shared = sharesSessions(store);
    this.store = store;
    this.owner = owner;
    this.ttlMs = ttlMs;
    this.report = report;
  }

  /**
   * Takes the lease, then keeps it alive until `stop()`; `onLeaseRenewed` runs once per lease,
   * after a renewal.
   */
  async start(onLeaseRenewed: () => void): Promise<void> {
    if (!this.shared) return;
    await this.renew();
    let renewals = 0;
    this.renewal = setInterval(() => {
      void this.renew().then(() => {
        renewals += 1;
        if (renewals % RENEWALS_PER_LEASE === 0) onLeaseRenewed();
      }, this.report('lease'));
    }, this.ttlMs / RENEWALS_PER_LEASE);
    this.renewal.unref();
  }

  stop(): void {
    clearInterval(this.renewal);
  }

  /** Makes this manager hold the session, unless another one does. */
  claim(id: string): Promise<SessionClaim> {
    const claimed = this.shared ? this.store.claimSession?.(id, this.owner) : undefined;
    return claimed ?? Promise.resolve({ claimed: true, previousOwner: this.owner });
  }

  /** Lets go of the session; a failure is reported, the lease expiring lets go of it anyway. */
  async release(id: string): Promise<void> {
    if (!this.shared) return;
    await this.store.releaseSession?.(id, this.owner)?.catch(this.report('release', id));
  }

  private async renew(): Promise<void> {
    await this.store.renewLease?.(this.owner, this.ttlMs);
  }
}
