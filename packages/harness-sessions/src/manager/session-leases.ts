import type { SessionStore } from '../definitions/store.js';

type Report = (action: string, sessionId?: string) => (error: unknown) => void;

/** How often a manager renews its lease: three times within its life. */
const RENEWALS_PER_LEASE = 3;

/** How many times a claim reads the session's holder again when another manager wrote it meanwhile. */
const CLAIM_ATTEMPTS = 5;

/** The methods of a store that shares its sessions between managers. */
type LeasingStore = Pick<
  SessionStore<unknown>,
  'getOwnership' | 'releaseOwnership' | 'renewOwnerships' | 'writeOwnership'
>;

const LEASE_METHODS = [
  'getOwnership',
  'writeOwnership',
  'renewOwnerships',
  'releaseOwnership',
] as const;

/** What a claim made of a session. */
export type SessionClaim =
  | {
      claimed: false;
      /** The manager that holds the session, its lease alive. */
      owner: string;
    }
  | {
      claimed: true;
      /**
       * Who held the session before: `null` when nobody did, the claiming manager itself when it
       * held it already, or a manager whose lease expired.
       */
      previousOwner: null | string;
    };

export interface SessionLeasesOptions {
  store: LeasingStore;
  /** This manager. */
  owner: string;
  ttlMs: number;
  report: Report;
}

/** Whether the store gives its lease methods: all four, or none. */
function sharesSessions(store: LeasingStore): boolean {
  const given = LEASE_METHODS.filter((method) => typeof store[method] === 'function').length;
  if (given !== 0 && given !== LEASE_METHODS.length) {
    throw new TypeError(
      'A session store shares its sessions with getOwnership, writeOwnership, renewOwnerships and releaseOwnership, all four.',
    );
  }
  return given === LEASE_METHODS.length;
}

/**
 * The sessions a manager holds in a store it shares with other managers, and the lease that keeps
 * them: renewed in the background, read by the other managers when they claim one. Claiming is a
 * compare-and-set on the session's holder, its version: two managers never both win. A store
 * without leases has one manager: every claim succeeds, and nothing is renewed.
 */
export class SessionLeases {
  readonly owner: string;
  /** Whether the store shares its sessions between managers. */
  readonly shared: boolean;
  private readonly store: Required<LeasingStore>;
  private readonly ttlMs: number;
  private readonly report: Report;
  private renewal: NodeJS.Timeout | undefined;
  /** When this manager's lease runs out, as it last renewed it: shared by all the sessions it holds. */
  private expiresAt = new Date(0);

  constructor({ store, owner, ttlMs, report }: SessionLeasesOptions) {
    this.shared = sharesSessions(store);
    this.store = store as Required<LeasingStore>;
    this.owner = owner;
    this.ttlMs = ttlMs;
    this.report = report;
  }

  /**
   * Renews the lease of the sessions this manager holds until `stop()`; `onLeaseRenewed` runs
   * once per lease, after a renewal.
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
  async claim(id: string): Promise<SessionClaim> {
    if (!this.shared) return { claimed: true, previousOwner: this.owner };
    for (let attempt = 0; attempt < CLAIM_ATTEMPTS; attempt += 1) {
      const current = await this.store.getOwnership(id);
      if (current === undefined) {
        if (await this.store.writeOwnership(id, this.ownership(1))) {
          return { claimed: true, previousOwner: null };
        }
        continue;
      }
      // A store may give the date back as a string.
      const expired = new Date(current.expiresAt).getTime() <= Date.now();
      if (current.owner !== this.owner && !expired) {
        return { claimed: false, owner: current.owner };
      }
      const ownership = this.ownership(current.version + 1);
      if (await this.store.writeOwnership(id, ownership, current.version)) {
        return { claimed: true, previousOwner: current.owner };
      }
    }
    throw new Error(`Session ${id} changed hands ${CLAIM_ATTEMPTS} times while it was claimed.`);
  }

  /** Lets go of the session; a failure is reported, the lease expiring lets go of it anyway. */
  async release(id: string): Promise<void> {
    if (!this.shared) return;
    await this.store.releaseOwnership(id, this.owner).catch(this.report('release', id));
  }

  private ownership(version: number) {
    return { owner: this.owner, expiresAt: this.expiry(), version };
  }

  /**
   * The expiry of the lease, the same for every session this manager holds, so that they all
   * expire together if it crashes; a new one if it lapsed, the manager stalled meanwhile.
   */
  private expiry(): Date {
    if (this.expiresAt.getTime() <= Date.now()) this.expiresAt = new Date(Date.now() + this.ttlMs);
    return this.expiresAt;
  }

  private async renew(): Promise<void> {
    const expiresAt = new Date(Date.now() + this.ttlMs);
    await this.store.renewOwnerships(this.owner, expiresAt);
    this.expiresAt = expiresAt;
  }
}
