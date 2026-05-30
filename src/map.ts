// pattern: Functional Core
// Pure mappers from CourtListener records to Cranch lexicon records.
// No I/O: document CIDs are supplied via a precomputed url->cid map.

import type {
  ClDocket,
  ClDocketEntry,
  ClParty,
} from "./courtlistener.types.js";

const CL_BASE = "https://www.courtlistener.com";
const STORAGE_BASE = "https://storage.courtlistener.com";

export function storageUrl(filepathLocal: string): string {
  return `${STORAGE_BASE}/${filepathLocal.replace(/^\/+/, "")}`;
}

export interface Source {
  provider: string;
  providerDocketId?: string;
  url?: string;
  retrievedAt: string;
}

export interface DocketRecord {
  $type: "com.proptermalone.cranch.docket";
  court: string;
  courtName?: string;
  docketNumber: string;
  caseName: string;
  dateFiled?: string;
  dateTerminated?: string;
  assignedJudge?: string;
  natureOfSuit?: string;
  source: Source;
  createdAt: string;
}

export interface DocumentRef {
  documentNumber?: number;
  description?: string;
  sourceUrl: string;
  contentCid?: string;
  mimeType?: string;
  pageCount?: number;
  isAvailable?: boolean;
}

export interface DocketEntryRecord {
  $type: "com.proptermalone.cranch.docketEntry";
  entryNumber?: number;
  recapSequenceNumber?: string;
  dateFiled: string;
  description: string;
  documents?: DocumentRef[];
  source: Source;
  createdAt: string;
}

export interface AttorneyRef {
  name: string;
  firm?: string;
  email?: string;
  role?: string;
}

export interface PartyRecord {
  $type: "com.proptermalone.cranch.party";
  name: string;
  role?: string;
  attorneys?: AttorneyRef[];
  source: Source;
  createdAt: string;
}

export function toIsoDatetime(
  date: string | null | undefined,
): string | undefined {
  if (!date) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(date)) return `${date}T00:00:00.000Z`;
  const d = new Date(date);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

export function makeSource(docket: ClDocket, retrievedAt: string): Source {
  return {
    provider: "courtlistener",
    providerDocketId: String(docket.id),
    url: docket.absolute_url ? `${CL_BASE}${docket.absolute_url}` : undefined,
    retrievedAt,
  };
}

export function mapDocket(
  docket: ClDocket,
  retrievedAt: string,
  createdAt: string,
): DocketRecord {
  return {
    $type: "com.proptermalone.cranch.docket",
    court: docket.court_id ?? "unknown",
    docketNumber: docket.docket_number ?? "unknown",
    caseName: docket.case_name ?? docket.case_name_full ?? "Unknown case",
    dateFiled: toIsoDatetime(docket.date_filed),
    dateTerminated: toIsoDatetime(docket.date_terminated),
    assignedJudge: docket.assigned_to_str ?? undefined,
    natureOfSuit: docket.nature_of_suit ?? undefined,
    source: makeSource(docket, retrievedAt),
    createdAt,
  };
}

function toDocumentNumber(n: number | string | null): number | undefined {
  if (n == null) return undefined;
  const v = typeof n === "string" ? Number(n) : n;
  return Number.isFinite(v) ? v : undefined;
}

export function mapEntry(
  entry: ClDocketEntry,
  source: Source,
  createdAt: string,
  cids: ReadonlyMap<string, string> = new Map(),
): DocketEntryRecord {
  const documents: DocumentRef[] = (entry.recap_documents ?? [])
    .filter((d): d is typeof d & { filepath_local: string } =>
      Boolean(d.filepath_local),
    )
    .map((d) => {
      const url = storageUrl(d.filepath_local);
      return {
        documentNumber: toDocumentNumber(d.document_number),
        description: d.description ?? undefined,
        sourceUrl: url,
        contentCid: cids.get(url),
        mimeType: "application/pdf",
        pageCount: d.page_count ?? undefined,
        isAvailable: d.is_available ?? undefined,
      };
    });
  return {
    $type: "com.proptermalone.cranch.docketEntry",
    entryNumber: entry.entry_number ?? undefined,
    recapSequenceNumber: entry.recap_sequence_number ?? undefined,
    dateFiled: toIsoDatetime(entry.date_filed) ?? createdAt,
    description: entry.description ?? "",
    documents: documents.length ? documents : undefined,
    source,
    createdAt,
  };
}

export function mapParty(
  party: ClParty,
  source: Source,
  createdAt: string,
): PartyRecord {
  const attorneys: AttorneyRef[] = (party.attorneys ?? [])
    .filter((a): a is typeof a & { name: string } => Boolean(a.name))
    .map((a) => ({ name: a.name }));
  return {
    $type: "com.proptermalone.cranch.party",
    name: party.name ?? "Unknown party",
    role: party.party_types?.[0]?.name ?? undefined,
    attorneys: attorneys.length ? attorneys : undefined,
    source,
    createdAt,
  };
}
