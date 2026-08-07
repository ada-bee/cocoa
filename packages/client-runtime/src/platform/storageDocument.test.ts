import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  BearerConnectionCredential,
  BearerConnectionProfile,
  BearerConnectionRegistration,
  DirectConnectionProfile,
  DirectConnectionRegistration,
} from "../connection/catalog.ts";
import { BearerConnectionTarget, DirectConnectionTarget } from "../connection/model.ts";
import {
  ConnectionCatalogDocument,
  EMPTY_CONNECTION_CATALOG_DOCUMENT,
  registerConnectionInCatalog,
  removeConnectionFromCatalog,
} from "./storageDocument.ts";

const environmentId = EnvironmentId.make("cocoa-gateway");
const target = new BearerConnectionTarget({
  environmentId,
  label: "Cocoa",
  connectionId: "bearer:cocoa-gateway",
});
const profile = new BearerConnectionProfile({
  connectionId: target.connectionId,
  environmentId,
  label: target.label,
  httpBaseUrl: "https://cocoa.example.test",
  wsBaseUrl: "wss://cocoa.example.test",
});
const credential = new BearerConnectionCredential({ token: "encrypted-at-rest-by-platform" });
const decodeCatalogDocument = Schema.decodeUnknownSync(ConnectionCatalogDocument);

describe("Cocoa connection catalog document", () => {
  it("persists a direct gateway without client credentials", () => {
    const directTarget = new DirectConnectionTarget({
      environmentId,
      label: "Cocoa",
      connectionId: "direct:cocoa-gateway",
    });
    const directProfile = new DirectConnectionProfile({
      connectionId: directTarget.connectionId,
      environmentId,
      label: directTarget.label,
      httpBaseUrl: "https://cocoa.example.test",
      wsBaseUrl: "wss://cocoa.example.test",
    });
    const document = registerConnectionInCatalog(
      EMPTY_CONNECTION_CATALOG_DOCUMENT,
      new DirectConnectionRegistration({ target: directTarget, profile: directProfile }),
    );

    expect(document).toEqual({
      schemaVersion: 1,
      targets: [directTarget],
      profiles: [directProfile],
      credentials: [],
    });
    expect(decodeCatalogDocument(document)).toEqual(document);
  });

  it("persists only direct bearer connection metadata", () => {
    const document = registerConnectionInCatalog(
      EMPTY_CONNECTION_CATALOG_DOCUMENT,
      new BearerConnectionRegistration({ target, profile, credential }),
    );

    expect(document).toEqual({
      schemaVersion: 1,
      targets: [target],
      profiles: [profile],
      credentials: [{ connectionId: target.connectionId, credential }],
    });
    expect(decodeCatalogDocument(document)).toEqual(document);
  });

  it("rejects legacy relay and SSH catalog fields instead of applying migration defaults", () => {
    expect(() =>
      decodeCatalogDocument({ ...EMPTY_CONNECTION_CATALOG_DOCUMENT, remoteDpopTokens: [] }),
    ).toThrow();
    expect(() =>
      decodeCatalogDocument({
        ...EMPTY_CONNECTION_CATALOG_DOCUMENT,
        targets: [{ _tag: "RelayConnectionTarget", environmentId, label: "Hosted" }],
      }),
    ).toThrow();
  });

  it("removes the target, profile, and credential together", () => {
    const populated = registerConnectionInCatalog(
      EMPTY_CONNECTION_CATALOG_DOCUMENT,
      new BearerConnectionRegistration({ target, profile, credential }),
    );
    expect(removeConnectionFromCatalog(populated, target)).toEqual(
      EMPTY_CONNECTION_CATALOG_DOCUMENT,
    );
  });
});
