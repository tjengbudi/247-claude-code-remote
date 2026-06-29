// Smoke import — verifies the Git contract types from 247-shared are importable by the agent.
// This file has no runtime content; it exists solely to satisfy the Story 6.1 DoD.
import type {
  GitExecResult,
  GitFileStatusFlags,
  GitFileInfo,
  GitBranchInfo,
  GitRepoStatus,
  GitCommit,
  GitDiffFile,
  GitCommitWithDiff,
  DiscoveredGitRepo,
  DiscoverReposOptions,
  DiscoverReposResult,
  GitRunOptions,
  SafeRefResult,
} from '247-shared';

export type {
  GitExecResult,
  GitFileStatusFlags,
  GitFileInfo,
  GitBranchInfo,
  GitRepoStatus,
  GitCommit,
  GitDiffFile,
  GitCommitWithDiff,
  DiscoveredGitRepo,
  DiscoverReposOptions,
  DiscoverReposResult,
  GitRunOptions,
  SafeRefResult,
};
