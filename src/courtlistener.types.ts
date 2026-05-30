// pattern: Functional Core (type declarations only)
// Subset of CourtListener REST v4 fields used by Cranch. Confirmed against
// docket 69777799 (Abrego Garcia v. Noem) on 2026-05-29.

export interface ClDocket {
  id: number;
  case_name: string | null;
  case_name_full: string | null;
  docket_number: string | null;
  court_id: string | null;
  date_filed: string | null;
  date_terminated: string | null;
  assigned_to_str: string | null;
  nature_of_suit: string | null;
  absolute_url: string | null;
}

export interface ClRecapDocument {
  document_number: number | string | null;
  description: string | null;
  filepath_local: string | null;
  page_count: number | null;
  is_available: boolean | null;
  pacer_doc_id: string | null;
}

export interface ClDocketEntry {
  id: number;
  entry_number: number | null;
  recap_sequence_number: string | null;
  date_filed: string | null;
  description: string | null;
  recap_documents: ClRecapDocument[];
}

export interface ClPartyType {
  name: string | null;
}

export interface ClAttorney {
  name: string | null;
  contact_raw?: string | null;
}

export interface ClParty {
  id: number;
  name: string | null;
  party_types: ClPartyType[];
  attorneys?: ClAttorney[];
}

export interface ClPage<T> {
  // CL returns count as a number, or a URL string when computed asynchronously.
  count: number | string | null;
  next: string | null;
  results: T[];
}
