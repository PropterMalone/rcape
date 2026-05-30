import { describe, expect, it } from "vitest";
import type {
  ClDocket,
  ClDocketEntry,
  ClParty,
} from "./courtlistener.types.js";
import {
  makeSource,
  mapDocket,
  mapEntry,
  mapParty,
  storageUrl,
  toIsoDatetime,
} from "./map.js";

const docket: ClDocket = {
  id: 69777799,
  case_name: "Abrego Garcia v. Noem",
  case_name_full: "",
  docket_number: "8:25-cv-00951",
  court_id: "mdd",
  date_filed: "2025-03-24",
  date_terminated: null,
  assigned_to_str: "Paula Xinis",
  nature_of_suit: "460 Deportation",
  absolute_url: "/docket/69777799/abrego-garcia-v-noem/",
};

describe("toIsoDatetime", () => {
  it("normalizes YYYY-MM-DD to UTC midnight", () => {
    expect(toIsoDatetime("2025-03-24")).toBe("2025-03-24T00:00:00.000Z");
  });
  it("returns undefined for null/empty", () => {
    expect(toIsoDatetime(null)).toBeUndefined();
    expect(toIsoDatetime(undefined)).toBeUndefined();
  });
});

describe("mapDocket", () => {
  it("maps the confirmed fields and builds a provenance source", () => {
    const r = mapDocket(
      docket,
      "2026-05-29T00:00:00.000Z",
      "2026-05-29T00:00:00.000Z",
    );
    expect(r.$type).toBe("com.proptermalone.cranch.docket");
    expect(r.caseName).toBe("Abrego Garcia v. Noem");
    expect(r.court).toBe("mdd");
    expect(r.docketNumber).toBe("8:25-cv-00951");
    expect(r.assignedJudge).toBe("Paula Xinis");
    expect(r.source.provider).toBe("courtlistener");
    expect(r.source.providerDocketId).toBe("69777799");
    expect(r.source.url).toContain("courtlistener.com/docket/69777799");
  });
});

describe("mapEntry", () => {
  const source = makeSource(docket, "2026-05-29T00:00:00.000Z");

  it("maps documents to storage URLs and attaches supplied CIDs", () => {
    const path = "recap/gov.uscourts.mdd.578815/x.1.0.pdf";
    const entry: ClDocketEntry = {
      id: 1,
      entry_number: 1,
      recap_sequence_number: "2025-03-24.001",
      date_filed: "2025-03-24",
      description: "COMPLAINT",
      recap_documents: [
        {
          document_number: 1,
          description: "Main Document",
          filepath_local: path,
          page_count: 21,
          is_available: true,
          pacer_doc_id: null,
        },
      ],
    };
    const url = storageUrl(path);
    const cids = new Map([[url, "bafkreiabc"]]);
    const r = mapEntry(entry, source, "2026-05-29T00:00:00.000Z", cids);
    expect(r.entryNumber).toBe(1);
    expect(r.documents?.[0]?.sourceUrl).toBe(url);
    expect(r.documents?.[0]?.contentCid).toBe("bafkreiabc");
    expect(r.documents?.[0]?.pageCount).toBe(21);
  });

  it("handles null entry_number (admin entries) with no documents", () => {
    const entry: ClDocketEntry = {
      id: 3,
      entry_number: null,
      recap_sequence_number: "2025-03-24.003",
      date_filed: "2025-03-24",
      description: "Case Reassigned to Judge Paula Xinis.",
      recap_documents: [],
    };
    const r = mapEntry(entry, source, "2026-05-29T00:00:00.000Z");
    expect(r.entryNumber).toBeUndefined();
    expect(r.documents).toBeUndefined();
  });
});

describe("mapParty", () => {
  it("takes role from the first party_type and maps attorneys", () => {
    const p: ClParty = {
      id: 1,
      name: "Kilmar Armando Abrego Garcia",
      party_types: [{ name: "Plaintiff" }],
      attorneys: [{ name: "Simon Sandoval-Moshenberg" }],
    };
    const r = mapParty(p, makeSource(docket, "t"), "t");
    expect(r.role).toBe("Plaintiff");
    expect(r.attorneys?.[0]?.name).toContain("Sandoval");
  });
});
