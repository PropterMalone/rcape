// pattern: Imperative Shell
// One authenticated AtpAgent bound to a single case repo on the PDS. Centralizes
// the login, the default PDS host (prior drift source — three CLIs each hardcoded
// it), paginated listRecords, and batched applyWrites that publish/fire/takedown
// used to each re-implement.

import { AtpAgent } from "@atproto/api";
import type { PostRef } from "./map.js";

export const DEFAULT_PDS_HOST = "pds.rcape.org";
const BATCH = 20;
const PAGE = 100;

export interface RepoRecord {
  rkey: string;
  uri: string;
  cid: string;
  value: Record<string, unknown>;
}

export interface CreateRow {
  collection: string;
  rkey: string;
  value: Record<string, unknown>;
}

export interface DeleteTarget {
  collection: string;
  rkey: string;
}

// The slice of AtpAgent CaseRepo depends on. Declaring it explicitly lets tests
// supply a plain mock instead of a full agent.
export interface RepoClient {
  com: {
    atproto: {
      repo: {
        listRecords(params: {
          repo: string;
          collection: string;
          limit?: number;
          cursor?: string;
        }): Promise<{
          data: {
            records: { uri: string; cid: string; value: unknown }[];
            cursor?: string;
          };
        }>;
        getRecord(params: {
          repo: string;
          collection: string;
          rkey: string;
        }): Promise<{ data: { uri: string; cid?: string; value: unknown } }>;
        putRecord(params: {
          repo: string;
          collection: string;
          rkey: string;
          record: unknown;
        }): Promise<unknown>;
        createRecord(params: {
          repo: string;
          collection: string;
          record: unknown;
        }): Promise<{ data: { uri: string; cid: string } }>;
        applyWrites(params: {
          repo: string;
          writes: unknown[];
        }): Promise<unknown>;
        uploadBlob(
          data: Uint8Array,
          opts: { encoding: string },
        ): Promise<{ data: { blob: unknown } }>;
      };
    };
  };
}

export class CaseRepo {
  private constructor(
    private readonly client: RepoClient,
    readonly did: string,
    readonly handle: string,
  ) {}

  /** Wrap an already-authenticated client (or a test mock). */
  static fromClient(client: RepoClient, did: string, handle: string): CaseRepo {
    return new CaseRepo(client, did, handle);
  }

  static async login(opts: {
    host?: string;
    identifier: string;
    password: string;
  }): Promise<CaseRepo> {
    const host = opts.host ?? DEFAULT_PDS_HOST;
    const agent = new AtpAgent({ service: `https://${host}` });
    await agent.login({ identifier: opts.identifier, password: opts.password });
    const did = agent.session?.did;
    if (!did) throw new Error("login failed: no session DID");
    // Single boundary cast: AtpAgent's generated param types (record: {}, typed
    // write unions) are richer than the narrow RepoClient seam we test against.
    return new CaseRepo(
      agent as unknown as RepoClient,
      did,
      agent.session?.handle ?? did,
    );
  }

  async *listAll(collection: string): AsyncGenerator<RepoRecord> {
    let cursor: string | undefined;
    do {
      const { data } = await this.client.com.atproto.repo.listRecords({
        repo: this.did,
        collection,
        limit: PAGE,
        cursor,
      });
      for (const r of data.records) {
        const rkey = r.uri.split("/").pop();
        if (rkey) {
          yield {
            rkey,
            uri: r.uri,
            cid: r.cid,
            value: r.value as Record<string, unknown>,
          };
        }
      }
      cursor = data.cursor;
    } while (cursor);
  }

  async collect(collection: string): Promise<RepoRecord[]> {
    const out: RepoRecord[] = [];
    for await (const r of this.listAll(collection)) out.push(r);
    return out;
  }

  async getRecord(
    collection: string,
    rkey: string,
  ): Promise<Record<string, unknown>> {
    const { data } = await this.client.com.atproto.repo.getRecord({
      repo: this.did,
      collection,
      rkey,
    });
    return data.value as Record<string, unknown>;
  }

  async putRecord(
    collection: string,
    rkey: string,
    record: Record<string, unknown>,
  ): Promise<void> {
    await this.client.com.atproto.repo.putRecord({
      repo: this.did,
      collection,
      rkey,
      record,
    });
  }

  async createRecord(
    collection: string,
    record: Record<string, unknown>,
  ): Promise<PostRef> {
    const { data } = await this.client.com.atproto.repo.createRecord({
      repo: this.did,
      collection,
      record,
    });
    return { uri: data.uri, cid: data.cid };
  }

  // Upload an image/blob and return the BlobRef to embed in a record
  // (e.g. profile.avatar / profile.banner).
  async uploadBlob(bytes: Uint8Array, mimeType: string): Promise<unknown> {
    const { data } = await this.client.com.atproto.repo.uploadBlob(bytes, {
      encoding: mimeType,
    });
    return data.blob;
  }

  async applyCreates(rows: CreateRow[]): Promise<void> {
    for (let i = 0; i < rows.length; i += BATCH) {
      await this.client.com.atproto.repo.applyWrites({
        repo: this.did,
        writes: rows.slice(i, i + BATCH).map((r) => ({
          $type: "com.atproto.repo.applyWrites#create",
          collection: r.collection,
          rkey: r.rkey,
          value: r.value,
        })),
      });
    }
  }

  async applyDeletes(targets: DeleteTarget[]): Promise<void> {
    for (let i = 0; i < targets.length; i += BATCH) {
      await this.client.com.atproto.repo.applyWrites({
        repo: this.did,
        writes: targets.slice(i, i + BATCH).map((t) => ({
          $type: "com.atproto.repo.applyWrites#delete",
          collection: t.collection,
          rkey: t.rkey,
        })),
      });
    }
  }
}
