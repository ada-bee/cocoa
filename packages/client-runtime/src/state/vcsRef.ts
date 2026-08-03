import type {
  EnvironmentId,
  RepositoryReadTarget,
  RepositoryRef as ContractVcsRef,
} from "@t3tools/contracts";

export interface VcsRefTarget {
  readonly environmentId: EnvironmentId | null;
  readonly target: RepositoryReadTarget | null;
  readonly query?: string | null;
}

export type VcsRef = ContractVcsRef;
