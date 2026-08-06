export type CocoaGatewayForbiddenCapability =
  | "hosted-connectivity"
  | "local-project-filesystem"
  | "local-project-vcs"
  | "local-shell-or-pty"
  | "provider-process-lifecycle";

export interface CocoaGatewaySourceFile {
  readonly path: string;
  readonly source: string;
}

export interface CocoaGatewayImportEdge {
  readonly sourcePath: string;
  readonly specifier: string;
  readonly targetPath: string | null;
}

export interface CocoaGatewayForbiddenCallsite extends CocoaGatewayImportEdge {
  readonly capability: CocoaGatewayForbiddenCapability;
}

export interface CocoaGatewayArchitectureClassification {
  readonly sourcePath: string;
  readonly specifier: string;
  readonly capability: CocoaGatewayForbiddenCapability;
  readonly classification:
    | "gateway-auth-secret-storage"
    | "gateway-attachment-storage"
    | "gateway-configuration-storage"
    | "gateway-diagnostics-storage"
    | "gateway-persistence"
    | "gateway-provider-event-log"
    | "gateway-unavailable-stub"
    | "provider-endpoint-ssh-transport"
    | "provider-endpoint-credential-storage"
    | "provider-host-readonly-helper"
    | "provider-host-terminal"
    | "provider-host-vcs-helper"
    | "shared-module-legacy-branch";
  readonly rationale: string;
}

export interface CocoaGatewayArchitectureAuditResult {
  readonly modules: ReadonlyArray<string>;
  readonly imports: ReadonlyArray<CocoaGatewayImportEdge>;
  readonly forbiddenCallsites: ReadonlyArray<CocoaGatewayForbiddenCallsite>;
  readonly unclassifiedCallsites: ReadonlyArray<CocoaGatewayForbiddenCallsite>;
  readonly staleClassifications: ReadonlyArray<CocoaGatewayArchitectureClassification>;
}

const staticImportSpecifierPattern =
  /^\s*(?:import|export)\s+(?:type\s+)?(?:[A-Za-z0-9_*{},\s]+?\s+from\s+)?["']([^"']+)["']/gm;
const dynamicImportSpecifierPattern = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
const requireSpecifierPattern = /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g;
const opaqueModuleLoadPattern = /\b(import|require)\s*\(([^)]*)\)/g;

const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

export function collectStaticImportSpecifiers(source: string): ReadonlyArray<string> {
  const withoutComments = stripComments(source);
  return [
    ...Array.from(withoutComments.matchAll(staticImportSpecifierPattern), (match) => match[1]!),
    ...Array.from(withoutComments.matchAll(dynamicImportSpecifierPattern), (match) => match[1]!),
    ...Array.from(withoutComments.matchAll(requireSpecifierPattern), (match) => match[1]!),
  ].sort();
}

const assertNoOpaqueModuleLoads = (sourcePath: string, source: string): void => {
  const withoutComments = stripComments(source);
  for (const match of withoutComments.matchAll(opaqueModuleLoadPattern)) {
    const argument = match[2]!.trim();
    if (!/^["'][^"']+["']$/.test(argument)) {
      throw new Error(
        `Cocoa runtime module '${sourcePath}' contains non-literal ${match[1]}(${argument}); dependency closure cannot be proven.`,
      );
    }
  }
};

const classifyForbiddenImport = (
  edge: CocoaGatewayImportEdge,
): CocoaGatewayForbiddenCapability | null => {
  const target = edge.targetPath ?? edge.specifier;
  if (
    edge.specifier === "node:child_process" ||
    edge.specifier === "node:pty" ||
    edge.specifier === "node-pty" ||
    edge.specifier === "effect/unstable/process" ||
    /(?:^|\/)(?:processRunner|process\/externalLauncher|preview\/PortScanner|terminal\/PtyAdapter)\.ts$/.test(
      target,
    )
  ) {
    return "local-shell-or-pty";
  }
  if (
    edge.specifier === "node:fs" ||
    edge.specifier === "node:fs/promises" ||
    edge.specifier === "effect/FileSystem" ||
    edge.specifier === "@effect/platform-node/NodeFileSystem" ||
    /(?:^|\/)(?:workspace\/Workspace(?:Paths|Entries)|project\/(?:T3ProjectFileLoader|RepositoryIdentityResolver))\.ts$/.test(
      target,
    )
  ) {
    return "local-project-filesystem";
  }
  if (/(?:^|\/)(?:git\/|vcs\/(?:Git|VcsProcess)|checkpointing\/CheckpointStore)/.test(target)) {
    return "local-project-vcs";
  }
  if (
    /(?:^|\/)(?:relay\/|cloud\/(?:CliState|CliTokenManager|ManagedEndpointRuntime|serviceLauncherClient|http|relayTracing))/.test(
      target,
    ) ||
    edge.specifier === "@t3tools/shared/relayClient" ||
    edge.specifier === "@t3tools/tailscale" ||
    /(?:tunnel|tailscale)/i.test(edge.specifier)
  ) {
    return "hosted-connectivity";
  }
  if (
    /(?:^|\/)(?:provider\/(?:codexLocal|CodexAppServerProcess)|resourceTelemetry\/ResourceMonitorBinary)/.test(
      target,
    )
  ) {
    return "provider-process-lifecycle";
  }
  return null;
};

const classificationKey = (value: {
  readonly sourcePath: string;
  readonly specifier: string;
  readonly capability: CocoaGatewayForbiddenCapability;
}): string => `${value.sourcePath}\0${value.specifier}\0${value.capability}`;

const forbiddenSymbolPatterns: ReadonlyArray<{
  readonly pattern: RegExp;
  readonly specifier: string;
  readonly capability: CocoaGatewayForbiddenCapability;
}> = [
  {
    pattern: /\bBun\.spawn(?:Sync)?\s*\(/,
    specifier: "symbol:Bun.spawn",
    capability: "provider-process-lifecycle",
  },
  {
    pattern: /\bDeno\.Command\s*\(/,
    specifier: "symbol:Deno.Command",
    capability: "local-shell-or-pty",
  },
  {
    pattern: /\bprocess\.kill\s*\(/,
    specifier: "symbol:process.kill",
    capability: "local-shell-or-pty",
  },
];

export function auditCocoaGatewayArchitecture(input: {
  readonly entryPath: string;
  readonly readSource: (path: string) => string | undefined;
  readonly resolveRelativeImport: (sourcePath: string, specifier: string) => string | undefined;
  readonly classifications: ReadonlyArray<CocoaGatewayArchitectureClassification>;
}): CocoaGatewayArchitectureAuditResult {
  const pending = [input.entryPath];
  const modules = new Set<string>();
  const imports: CocoaGatewayImportEdge[] = [];
  const sources = new Map<string, string>();

  while (pending.length > 0) {
    const sourcePath = pending.pop()!;
    if (modules.has(sourcePath)) continue;
    const source = input.readSource(sourcePath);
    if (source === undefined) {
      throw new Error(`Cocoa runtime dependency '${sourcePath}' could not be read.`);
    }
    modules.add(sourcePath);
    sources.set(sourcePath, source);
    assertNoOpaqueModuleLoads(sourcePath, source);
    for (const specifier of collectStaticImportSpecifiers(source)) {
      const targetPath = specifier.startsWith(".")
        ? (input.resolveRelativeImport(sourcePath, specifier) ?? null)
        : null;
      if (specifier.startsWith(".") && targetPath === null) {
        throw new Error(
          `Cocoa runtime import '${specifier}' from '${sourcePath}' could not be resolved.`,
        );
      }
      imports.push({ sourcePath, specifier, targetPath });
      if (targetPath !== null) pending.push(targetPath);
    }
  }

  const forbiddenImports = imports.flatMap((edge) => {
    const capability = classifyForbiddenImport(edge);
    return capability === null ? [] : [{ ...edge, capability }];
  });
  const forbiddenSymbols = Array.from(sources).flatMap(([sourcePath, source]) =>
    forbiddenSymbolPatterns.flatMap(({ pattern, specifier, capability }) =>
      pattern.test(source) ? [{ sourcePath, specifier, targetPath: null, capability }] : [],
    ),
  );
  const forbiddenCallsites = [...forbiddenImports, ...forbiddenSymbols];
  const classifiedKeys = new Set(input.classifications.map(classificationKey));
  const actualKeys = new Set(forbiddenCallsites.map(classificationKey));

  return {
    modules: Array.from(modules).sort(),
    imports: imports.toSorted((left, right) =>
      `${left.sourcePath}\0${left.specifier}`.localeCompare(
        `${right.sourcePath}\0${right.specifier}`,
      ),
    ),
    forbiddenCallsites: forbiddenCallsites.toSorted((left, right) =>
      classificationKey(left).localeCompare(classificationKey(right)),
    ),
    unclassifiedCallsites: forbiddenCallsites.filter(
      (callsite) => !classifiedKeys.has(classificationKey(callsite)),
    ),
    staleClassifications: input.classifications.filter(
      (classification) => !actualKeys.has(classificationKey(classification)),
    ),
  };
}
