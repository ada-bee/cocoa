use std::ffi::OsString;
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use cap_fs_ext::{FollowSymlinks, OpenOptionsFollowExt};
use cap_std::ambient_authority;
use cap_std::fs::{Dir, MetadataExt as _, OpenOptions as CapOpenOptions};
use fs2::FileExt as _;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

const PROTOCOL: &str = "cocoa.checkpoint.v1";
const MAX_PATH_BYTES: usize = 4_096;
const MAX_ENCODED_REQUEST_BYTES: usize = 131_072;
const MAX_DECODED_REQUEST_BYTES: usize = 65_536;
const MAX_RESPONSE_BYTES: usize = 6 * 1_024 * 1_024;
const MAX_GIT_OUTPUT_BYTES: usize = 1024 * 1024;
const MAX_DIFF_BYTES: usize = 4 * 1024 * 1024;

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
enum ErrorCode {
    UnsupportedProtocol,
    UnsupportedOperation,
    InvalidRequest,
    InvalidGitExecutable,
    NotARepository,
    UnsupportedObjectFormat,
    BindingChanged,
    CheckpointNotFound,
    CheckpointExists,
    CheckpointOidMismatch,
    OperationIdConflict,
    RepositoryBusy,
    RequestTooLarge,
    ResponseTooLarge,
    OperationFailed,
}

#[derive(Debug)]
struct CheckpointError {
    code: ErrorCode,
    message: &'static str,
}

impl CheckpointError {
    const fn new(code: ErrorCode, message: &'static str) -> Self {
        Self { code, message }
    }
}

type Result<T> = std::result::Result<T, CheckpointError>;

#[derive(Debug, Serialize)]
struct ErrorBody {
    code: ErrorCode,
    message: &'static str,
    retryable: bool,
}

#[derive(Debug, Serialize)]
struct ErrorResponse {
    protocol: &'static str,
    ok: bool,
    error: ErrorBody,
}

#[derive(Debug, Serialize)]
struct SuccessResponse<T> {
    protocol: &'static str,
    ok: bool,
    result: T,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RootIdentity {
    canonical_path: String,
    device: String,
    inode: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RepositoryBinding {
    worktree_root: RootIdentity,
    git_directory_root: RootIdentity,
    git_common_directory_root: RootIdentity,
    object_format: String,
    fingerprint: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DiffLimits {
    max_patch_bytes: usize,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DeleteCheckpoint {
    checkpoint_id: String,
    expected_checkpoint_oid: String,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "operation", rename_all = "lowercase", deny_unknown_fields)]
enum Request {
    Probe {
        protocol: String,
        #[serde(rename = "gitExecutablePath")]
        git_executable_path: String,
    },
    Open {
        protocol: String,
        #[serde(rename = "gitExecutablePath")]
        git_executable_path: String,
        #[serde(rename = "workspaceRoot")]
        workspace_root: String,
    },
    Capture {
        protocol: String,
        #[serde(rename = "gitExecutablePath")]
        git_executable_path: String,
        #[serde(rename = "expectedBinding")]
        expected_binding: RepositoryBinding,
        #[serde(rename = "operationId")]
        operation_id: String,
        #[serde(rename = "checkpointId")]
        checkpoint_id: String,
    },
    Diff {
        protocol: String,
        #[serde(rename = "gitExecutablePath")]
        git_executable_path: String,
        #[serde(rename = "expectedBinding")]
        expected_binding: RepositoryBinding,
        #[serde(rename = "baseCheckpointId")]
        base_checkpoint_id: String,
        #[serde(rename = "targetCheckpointId")]
        target_checkpoint_id: String,
        #[serde(rename = "ignoreWhitespace")]
        ignore_whitespace: bool,
        limits: DiffLimits,
    },
    Restore {
        protocol: String,
        #[serde(rename = "gitExecutablePath")]
        git_executable_path: String,
        #[serde(rename = "expectedBinding")]
        expected_binding: RepositoryBinding,
        #[serde(rename = "operationId")]
        operation_id: String,
        #[serde(rename = "checkpointId")]
        checkpoint_id: String,
        #[serde(rename = "expectedCheckpointOid")]
        expected_checkpoint_oid: String,
    },
    Delete {
        protocol: String,
        #[serde(rename = "gitExecutablePath")]
        git_executable_path: String,
        #[serde(rename = "expectedBinding")]
        expected_binding: RepositoryBinding,
        #[serde(rename = "operationId")]
        operation_id: String,
        checkpoints: Vec<DeleteCheckpoint>,
    },
    Observe {
        protocol: String,
        #[serde(rename = "gitExecutablePath")]
        git_executable_path: String,
        #[serde(rename = "expectedBinding")]
        expected_binding: RepositoryBinding,
        #[serde(rename = "operationId")]
        operation_id: String,
        #[serde(rename = "expectedRequestSha256")]
        expected_request_sha256: String,
    },
}

impl Request {
    fn protocol(&self) -> &str {
        match self {
            Self::Probe { protocol, .. }
            | Self::Open { protocol, .. }
            | Self::Capture { protocol, .. }
            | Self::Diff { protocol, .. }
            | Self::Restore { protocol, .. }
            | Self::Delete { protocol, .. }
            | Self::Observe { protocol, .. } => protocol,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProbeResult {
    operation: &'static str,
    implementation: &'static str,
    git_executable_path: String,
    capabilities: [&'static str; 7],
    object_formats: [&'static str; 2],
    limits: ProtocolLimits,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProtocolLimits {
    max_request_bytes: usize,
    max_patch_bytes: usize,
    max_response_bytes: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct OpenResult {
    operation: &'static str,
    binding: RepositoryBinding,
    head_oid: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct MutationResult {
    operation: &'static str,
    receipt: Value,
    receipt_object_oid: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DiffResult {
    operation: &'static str,
    base_checkpoint_id: String,
    target_checkpoint_id: String,
    base_oid: String,
    target_oid: String,
    patch_base64: String,
    byte_length: u64,
    truncated: bool,
}

struct Repository {
    git: String,
    binding: RepositoryBinding,
    common_dir: PathBuf,
}

struct RepositoryLock {
    file: File,
}

impl RepositoryLock {
    fn acquire(common_dir: &Path) -> Result<Self> {
        let directory = Dir::open_ambient_dir(common_dir, ambient_authority())
            .map_err(|_| operation_failed())?;
        let mut options = CapOpenOptions::new();
        options
            .create(true)
            .read(true)
            .write(true)
            .truncate(false)
            .follow(FollowSymlinks::No);
        let file = directory
            .open_with("cocoa-checkpoint-v1.lock", &options)
            .map_err(|_| operation_failed())?
            .into_std();
        file.try_lock_exclusive()
            .map_err(|_| CheckpointError::new(ErrorCode::RepositoryBusy, "Repository is busy."))?;
        Ok(Self { file })
    }
}

impl Drop for RepositoryLock {
    fn drop(&mut self) {
        let _ = self.file.unlock();
    }
}

struct TempIndex {
    path: PathBuf,
    reservation: PathBuf,
}

impl TempIndex {
    fn create(common_dir: &Path, operation_id: &str) -> Result<Self> {
        let common = Dir::open_ambient_dir(common_dir, ambient_authority())
            .map_err(|_| operation_failed())?;
        let directory = ensure_child_directory(&common, "cocoa-checkpoint-tmp-v1")?;
        let directory_path = common_dir.join("cocoa-checkpoint-tmp-v1");
        let index_name = format!("{operation_id}.index");
        let reservation_name = format!("{operation_id}.reserve");
        let path = directory_path.join(&index_name);
        let reservation = directory_path.join(&reservation_name);
        let mut options = CapOpenOptions::new();
        options
            .create_new(true)
            .write(true)
            .follow(FollowSymlinks::No);
        let _file = directory
            .open_with(&reservation_name, &options)
            .map_err(|_| CheckpointError::new(ErrorCode::RepositoryBusy, "Repository is busy."))?;
        if directory.symlink_metadata(&index_name).is_ok() {
            let _ = fs::remove_file(&reservation);
            return Err(CheckpointError::new(
                ErrorCode::RepositoryBusy,
                "Repository is busy.",
            ));
        }
        Ok(Self { path, reservation })
    }
}

impl Drop for TempIndex {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
        let _ = fs::remove_file(&self.reservation);
    }
}

pub(super) fn is_checkpoint_request(args: &[OsString]) -> bool {
    let [encoded] = args else { return false };
    let Some(encoded) = encoded.to_str() else {
        return false;
    };
    if encoded.len() > MAX_ENCODED_REQUEST_BYTES {
        return false;
    }
    let Ok(decoded) = BASE64.decode(encoded.as_bytes()) else {
        return false;
    };
    serde_json::from_slice::<Value>(&decoded)
        .ok()
        .and_then(|value| {
            value
                .get("protocol")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .is_some_and(|protocol| protocol == PROTOCOL || protocol.starts_with("cocoa.checkpoint."))
}

pub(super) fn run_argv(args: Vec<OsString>) -> Vec<u8> {
    match dispatch_argv(args) {
        Ok(value) => frame_value(value),
        Err(error) => frame_error(error),
    }
}

pub(super) fn internal_error_frame() -> Vec<u8> {
    frame_error(operation_failed())
}

fn dispatch_argv(args: Vec<OsString>) -> Result<Value> {
    let [encoded] = args.as_slice() else {
        return Err(CheckpointError::new(
            ErrorCode::InvalidRequest,
            "Expected one encoded checkpoint request.",
        ));
    };
    let encoded = encoded.to_str().ok_or_else(operation_failed)?;
    if encoded.len() > MAX_ENCODED_REQUEST_BYTES {
        return Err(CheckpointError::new(
            ErrorCode::RequestTooLarge,
            "Encoded request is too large.",
        ));
    }
    let decoded = BASE64
        .decode(encoded.as_bytes())
        .map_err(|_| operation_failed())?;
    if decoded.len() > MAX_DECODED_REQUEST_BYTES {
        return Err(CheckpointError::new(
            ErrorCode::RequestTooLarge,
            "Decoded request is too large.",
        ));
    }
    let value: Value = serde_json::from_slice(&decoded).map_err(|_| operation_failed())?;
    let object = value.as_object().ok_or_else(operation_failed)?;
    if object.get("protocol").and_then(Value::as_str) != Some(PROTOCOL) {
        return Err(CheckpointError::new(
            ErrorCode::UnsupportedProtocol,
            "Unsupported checkpoint helper protocol.",
        ));
    }
    match object.get("operation").and_then(Value::as_str) {
        Some("probe" | "open" | "capture" | "diff" | "restore" | "delete" | "observe") => {}
        _ => {
            return Err(CheckpointError::new(
                ErrorCode::UnsupportedOperation,
                "Unsupported checkpoint helper operation.",
            ))
        }
    }
    let request: Request = serde_json::from_value(value).map_err(|_| {
        CheckpointError::new(
            ErrorCode::InvalidRequest,
            "Checkpoint request shape is invalid.",
        )
    })?;
    if request.protocol() != PROTOCOL {
        return Err(CheckpointError::new(
            ErrorCode::UnsupportedProtocol,
            "Unsupported checkpoint helper protocol.",
        ));
    }
    dispatch(request, &decoded)
}

fn dispatch(request: Request, raw: &[u8]) -> Result<Value> {
    match request {
        Request::Probe {
            git_executable_path,
            ..
        } => {
            validate_git_executable(&git_executable_path)?;
            success(ProbeResult {
                operation: "probe",
                implementation: "cocoa-workspace-helper-rust",
                git_executable_path,
                capabilities: [
                    "probe", "open", "capture", "diff", "restore", "delete", "observe",
                ],
                object_formats: ["sha1", "sha256"],
                limits: ProtocolLimits {
                    max_request_bytes: MAX_DECODED_REQUEST_BYTES,
                    max_patch_bytes: MAX_DIFF_BYTES,
                    max_response_bytes: MAX_RESPONSE_BYTES,
                },
            })
        }
        Request::Open {
            git_executable_path,
            workspace_root,
            ..
        } => {
            let repository = open_repository(&git_executable_path, &workspace_root)?;
            let head_oid = try_resolve_revision(&repository, "HEAD")?;
            success(OpenResult {
                operation: "open",
                binding: repository.binding,
                head_oid,
            })
        }
        Request::Capture {
            git_executable_path,
            expected_binding,
            operation_id,
            checkpoint_id,
            ..
        } => {
            let repository = verify_repository(&git_executable_path, &expected_binding)?;
            mutation_capture(&repository, raw, operation_id, checkpoint_id).and_then(success)
        }
        Request::Diff {
            git_executable_path,
            expected_binding,
            base_checkpoint_id,
            target_checkpoint_id,
            ignore_whitespace,
            limits,
            ..
        } => {
            let repository = verify_repository(&git_executable_path, &expected_binding)?;
            checkpoint_diff(
                &repository,
                base_checkpoint_id,
                target_checkpoint_id,
                ignore_whitespace,
                limits.max_patch_bytes,
            )
            .and_then(success)
        }
        Request::Restore {
            git_executable_path,
            expected_binding,
            operation_id,
            checkpoint_id,
            expected_checkpoint_oid,
            ..
        } => {
            let repository = verify_repository(&git_executable_path, &expected_binding)?;
            mutation_restore(
                &repository,
                raw,
                operation_id,
                checkpoint_id,
                expected_checkpoint_oid,
            )
            .and_then(success)
        }
        Request::Delete {
            git_executable_path,
            expected_binding,
            operation_id,
            checkpoints,
            ..
        } => {
            let repository = verify_repository(&git_executable_path, &expected_binding)?;
            mutation_delete(&repository, raw, operation_id, checkpoints).and_then(success)
        }
        Request::Observe {
            git_executable_path,
            expected_binding,
            operation_id,
            expected_request_sha256,
            ..
        } => {
            let repository = verify_repository(&git_executable_path, &expected_binding)?;
            observe(&repository, operation_id, expected_request_sha256).and_then(success)
        }
    }
}

fn open_repository(git: &str, workspace_root: &str) -> Result<Repository> {
    let executable = validate_git_executable(git)?;
    validate_absolute_normalized(workspace_root)?;
    let worktree_identity = directory_identity(workspace_root, ErrorCode::NotARepository)?;
    let worktree = PathBuf::from(&worktree_identity.canonical_path);
    let worktree_string = worktree_identity.canonical_path.clone();

    let common = git_stdout(
        &executable,
        &worktree,
        &["rev-parse", "--path-format=absolute", "--git-common-dir"],
        None,
        MAX_PATH_BYTES,
    )?;
    let git_dir = git_stdout(
        &executable,
        &worktree,
        &["rev-parse", "--path-format=absolute", "--git-dir"],
        None,
        MAX_PATH_BYTES,
    )?;
    let top = git_stdout(
        &executable,
        &worktree,
        &["rev-parse", "--show-toplevel"],
        None,
        MAX_PATH_BYTES,
    )?;
    if top != worktree_string {
        return Err(CheckpointError::new(
            ErrorCode::NotARepository,
            "Workspace root must be the repository worktree root.",
        ));
    }
    let object_format = git_stdout(
        &executable,
        &worktree,
        &["rev-parse", "--show-object-format"],
        None,
        16,
    )?;
    if object_format != "sha1" && object_format != "sha256" {
        return Err(CheckpointError::new(
            ErrorCode::UnsupportedObjectFormat,
            "Repository object format is unsupported.",
        ));
    }
    let git_directory_root = directory_identity(&git_dir, ErrorCode::NotARepository)?;
    let git_common_directory_root = directory_identity(&common, ErrorCode::NotARepository)?;
    let common_dir = PathBuf::from(&git_common_directory_root.canonical_path);
    let git_directory_path = Path::new(&git_directory_root.canonical_path);
    if git_directory_path != common_dir && !git_directory_path.starts_with(&common_dir) {
        return Err(CheckpointError::new(
            ErrorCode::NotARepository,
            "Repository metadata layout is invalid.",
        ));
    }
    let worktree_root = worktree_identity;
    let mut fingerprint_hasher = Sha256::new();
    for value in [
        PROTOCOL,
        worktree_root.canonical_path.as_str(),
        worktree_root.device.as_str(),
        worktree_root.inode.as_str(),
        git_directory_root.canonical_path.as_str(),
        git_directory_root.device.as_str(),
        git_directory_root.inode.as_str(),
        git_common_directory_root.canonical_path.as_str(),
        git_common_directory_root.device.as_str(),
        git_common_directory_root.inode.as_str(),
        object_format.as_str(),
    ] {
        fingerprint_hasher.update(value.as_bytes());
        fingerprint_hasher.update([0]);
    }
    let fingerprint = format!("{:x}", fingerprint_hasher.finalize());
    Ok(Repository {
        git: executable,
        common_dir,
        binding: RepositoryBinding {
            worktree_root,
            git_directory_root,
            git_common_directory_root,
            object_format,
            fingerprint,
        },
    })
}

fn verify_repository(git: &str, expected: &RepositoryBinding) -> Result<Repository> {
    validate_binding(expected)?;
    let repository = open_repository(git, &expected.worktree_root.canonical_path)?;
    if repository.binding != *expected {
        return Err(CheckpointError::new(
            ErrorCode::BindingChanged,
            "Repository binding changed.",
        ));
    }
    Ok(repository)
}

fn validate_binding(binding: &RepositoryBinding) -> Result<()> {
    for identity in [
        &binding.worktree_root,
        &binding.git_directory_root,
        &binding.git_common_directory_root,
    ] {
        validate_absolute_normalized(&identity.canonical_path).map_err(|_| {
            CheckpointError::new(ErrorCode::BindingChanged, "Repository binding is invalid.")
        })?;
        for value in [&identity.device, &identity.inode] {
            if value.is_empty()
                || value.len() > 32
                || (value.len() > 1 && value.starts_with('0'))
                || !value.bytes().all(|byte| byte.is_ascii_digit())
            {
                return Err(CheckpointError::new(
                    ErrorCode::BindingChanged,
                    "Repository binding is invalid.",
                ));
            }
        }
    }
    if binding.object_format != "sha1" && binding.object_format != "sha256" {
        return Err(CheckpointError::new(
            ErrorCode::BindingChanged,
            "Repository binding is invalid.",
        ));
    }
    validate_hex_digest(&binding.fingerprint).map_err(|_| {
        CheckpointError::new(ErrorCode::BindingChanged, "Repository binding is invalid.")
    })
}

fn mutation_capture(
    repository: &Repository,
    raw: &[u8],
    operation_id: String,
    checkpoint_id: String,
) -> Result<MutationResult> {
    validate_uuid(&operation_id)?;
    validate_uuid(&checkpoint_id)?;
    let digest = request_digest(raw)?;
    let _lock = RepositoryLock::acquire(&repository.common_dir)?;
    validate_read_metadata(repository, &[&checkpoint_id], Some(&operation_id))?;
    if let Some(result) = existing_receipt(repository, &operation_id, &digest)? {
        return Ok(result);
    }
    ensure_no_external_filters(repository)?;
    validate_writable_metadata(repository, true, &[&checkpoint_id], &operation_id)?;
    ensure_ref_missing(repository, &checkpoint_ref(&checkpoint_id))?;
    let index = TempIndex::create(&repository.common_dir, &operation_id)?;
    if let Some(head) = try_resolve_revision(repository, "HEAD")? {
        git_status(repository, &["read-tree", &head], Some(&index.path), None)?;
    } else {
        git_status(
            repository,
            &["read-tree", "--empty"],
            Some(&index.path),
            None,
        )?;
    }
    git_status(
        repository,
        &["add", "-A", "--", "."],
        Some(&index.path),
        None,
    )?;
    let tree = git_stdout(
        &repository.git,
        Path::new(&repository.binding.worktree_root.canonical_path),
        &["write-tree"],
        Some(&index.path),
        128,
    )?;
    validate_object_id_for(repository, &tree)?;
    let commit = git_stdout_with_env(
        &repository.git,
        Path::new(&repository.binding.worktree_root.canonical_path),
        &["-c", "commit.gpgSign=false", "commit-tree", &tree],
        None,
        MAX_GIT_OUTPUT_BYTES,
        &[
            ("GIT_AUTHOR_NAME", "Cocoa Checkpoint"),
            ("GIT_AUTHOR_EMAIL", "checkpoint@cocoa.invalid"),
            ("GIT_COMMITTER_NAME", "Cocoa Checkpoint"),
            ("GIT_COMMITTER_EMAIL", "checkpoint@cocoa.invalid"),
        ],
        Some(b"Cocoa checkpoint\n"),
    )?;
    validate_object_id_for(repository, &commit)?;
    let receipt = serde_json::json!({
        "operation": "capture",
        "operationId": operation_id,
        "checkpointId": checkpoint_id,
        "checkpointRef": checkpoint_ref(&checkpoint_id),
        "checkpointOid": commit,
        "treeOid": tree,
        "requestSha256": digest,
        "repositoryFingerprint": repository.binding.fingerprint,
        "receiptRef": receipt_ref(&operation_id),
        "status": "succeeded",
    });
    let receipt_oid = write_receipt(repository, &receipt)?;
    update_refs(
        repository,
        &[
            format!("create {} {}", checkpoint_ref(&checkpoint_id), commit),
            format!("create {} {}", receipt_ref(&operation_id), receipt_oid),
        ],
    )?;
    Ok(MutationResult {
        operation: "capture",
        receipt,
        receipt_object_oid: receipt_oid,
    })
}

fn mutation_delete(
    repository: &Repository,
    raw: &[u8],
    operation_id: String,
    checkpoints: Vec<DeleteCheckpoint>,
) -> Result<MutationResult> {
    validate_uuid(&operation_id)?;
    if checkpoints.is_empty() || checkpoints.len() > 256 {
        return Err(CheckpointError::new(
            ErrorCode::InvalidRequest,
            "Checkpoint delete batch is invalid.",
        ));
    }
    for item in &checkpoints {
        validate_uuid(&item.checkpoint_id)?;
        validate_object_id_for(repository, &item.expected_checkpoint_oid)?;
    }
    let checkpoint_ids: Vec<_> = checkpoints
        .iter()
        .map(|item| item.checkpoint_id.as_str())
        .collect();
    let digest = request_digest(raw)?;
    let _lock = RepositoryLock::acquire(&repository.common_dir)?;
    validate_read_metadata(repository, &checkpoint_ids, Some(&operation_id))?;
    if let Some(result) = existing_receipt(repository, &operation_id, &digest)? {
        return Ok(result);
    }
    validate_writable_metadata(repository, false, &checkpoint_ids, &operation_id)?;
    let mut seen = std::collections::HashSet::new();
    let mut receipt_items = Vec::with_capacity(checkpoints.len());
    let mut commands = Vec::with_capacity(checkpoints.len() + 1);
    for item in checkpoints {
        if !seen.insert(item.checkpoint_id.clone()) {
            return Err(CheckpointError::new(
                ErrorCode::InvalidRequest,
                "Checkpoint delete batch is invalid.",
            ));
        }
        let reference = checkpoint_ref(&item.checkpoint_id);
        match try_resolve_ref(repository, &reference)? {
            None => receipt_items.push(serde_json::json!({
                "checkpointId": item.checkpoint_id,
                "checkpointRef": reference,
                "status": "already_absent",
            })),
            Some(actual) if actual == item.expected_checkpoint_oid => {
                commands.push(format!("delete {reference} {actual}"));
                receipt_items.push(serde_json::json!({
                    "checkpointId": item.checkpoint_id,
                    "checkpointRef": reference,
                    "status": "deleted",
                    "deletedCheckpointOid": actual,
                }));
            }
            Some(_) => {
                return Err(CheckpointError::new(
                    ErrorCode::CheckpointOidMismatch,
                    "Checkpoint object did not match.",
                ))
            }
        }
    }
    let receipt = serde_json::json!({
        "operation": "delete",
        "operationId": operation_id,
        "checkpoints": receipt_items,
        "requestSha256": digest,
        "repositoryFingerprint": repository.binding.fingerprint,
        "receiptRef": receipt_ref(&operation_id),
        "status": "succeeded",
    });
    let receipt_oid = write_receipt(repository, &receipt)?;
    commands.push(format!(
        "create {} {}",
        receipt_ref(&operation_id),
        receipt_oid
    ));
    update_refs(repository, &commands)?;
    Ok(MutationResult {
        operation: "delete",
        receipt,
        receipt_object_oid: receipt_oid,
    })
}

fn mutation_restore(
    repository: &Repository,
    raw: &[u8],
    operation_id: String,
    checkpoint_id: String,
    expected_checkpoint_oid: String,
) -> Result<MutationResult> {
    validate_uuid(&operation_id)?;
    validate_uuid(&checkpoint_id)?;
    validate_object_id_for(repository, &expected_checkpoint_oid)?;
    let digest = request_digest(raw)?;
    let _lock = RepositoryLock::acquire(&repository.common_dir)?;
    validate_read_metadata(repository, &[&checkpoint_id], Some(&operation_id))?;
    if let Some(result) = existing_receipt(repository, &operation_id, &digest)? {
        return Ok(result);
    }
    ensure_no_external_filters(repository)?;
    validate_writable_metadata(repository, true, &[&checkpoint_id], &operation_id)?;
    let checkpoint_oid = resolve_ref(
        repository,
        &checkpoint_ref(&checkpoint_id),
        ErrorCode::CheckpointNotFound,
    )?;
    if checkpoint_oid != expected_checkpoint_oid {
        return Err(CheckpointError::new(
            ErrorCode::CheckpointOidMismatch,
            "Checkpoint object did not match.",
        ));
    }
    git_status(
        repository,
        &[
            "restore",
            "--source",
            &checkpoint_oid,
            "--worktree",
            "--staged",
            "--",
            ".",
        ],
        None,
        None,
    )?;
    git_status(repository, &["clean", "-fd", "--", "."], None, None)?;
    if let Some(head) = try_resolve_revision(repository, "HEAD")? {
        git_status(repository, &["read-tree", &head], None, None)?;
    } else {
        git_status(repository, &["read-tree", "--empty"], None, None)?;
    }
    let receipt = serde_json::json!({
        "operation": "restore",
        "operationId": operation_id,
        "checkpointId": checkpoint_id,
        "checkpointRef": checkpoint_ref(&checkpoint_id),
        "checkpointOid": checkpoint_oid,
        "requestSha256": digest,
        "repositoryFingerprint": repository.binding.fingerprint,
        "receiptRef": receipt_ref(&operation_id),
        "status": "succeeded",
    });
    let receipt_oid = write_receipt(repository, &receipt)?;
    update_refs(
        repository,
        &[format!(
            "create {} {}",
            receipt_ref(&operation_id),
            receipt_oid
        )],
    )?;
    Ok(MutationResult {
        operation: "restore",
        receipt,
        receipt_object_oid: receipt_oid,
    })
}

fn checkpoint_diff(
    repository: &Repository,
    base_checkpoint_id: String,
    target_checkpoint_id: String,
    ignore_whitespace: bool,
    max_bytes: usize,
) -> Result<DiffResult> {
    validate_uuid(&base_checkpoint_id)?;
    validate_uuid(&target_checkpoint_id)?;
    if max_bytes == 0 || max_bytes > MAX_DIFF_BYTES {
        return Err(CheckpointError::new(
            ErrorCode::InvalidRequest,
            "Invalid diff byte limit.",
        ));
    }
    validate_read_metadata(
        repository,
        &[&base_checkpoint_id, &target_checkpoint_id],
        None,
    )?;
    let base_oid = resolve_ref(
        repository,
        &checkpoint_ref(&base_checkpoint_id),
        ErrorCode::CheckpointNotFound,
    )?;
    let target_oid = resolve_ref(
        repository,
        &checkpoint_ref(&target_checkpoint_id),
        ErrorCode::CheckpointNotFound,
    )?;
    let mut args = vec!["diff", "--binary", "--no-ext-diff", "--no-textconv"];
    if ignore_whitespace {
        args.push("--ignore-all-space");
    }
    args.extend([base_oid.as_str(), target_oid.as_str(), "--", "."]);
    let output = git_bounded(repository, &args, None, max_bytes)?;
    let byte_length = u64::try_from(output.bytes.len()).map_err(|_| operation_failed())?;
    Ok(DiffResult {
        operation: "diff",
        base_checkpoint_id,
        target_checkpoint_id,
        base_oid,
        target_oid,
        patch_base64: BASE64.encode(output.bytes),
        byte_length,
        truncated: output.truncated,
    })
}

fn observe(repository: &Repository, operation_id: String, request_digest: String) -> Result<Value> {
    validate_uuid(&operation_id)?;
    validate_hex_digest(&request_digest)?;
    validate_read_metadata(repository, &[], Some(&operation_id))?;
    let Some(receipt_oid) = try_resolve_ref(repository, &receipt_ref(&operation_id))? else {
        return Ok(serde_json::json!({"operation": "observe", "status": "not_found"}));
    };
    let bytes = git_bytes(
        repository,
        &["cat-file", "blob", &receipt_oid],
        None,
        MAX_GIT_OUTPUT_BYTES,
    )?
    .bytes;
    let receipt: Value = serde_json::from_slice(&bytes).map_err(|_| {
        CheckpointError::new(
            ErrorCode::OperationIdConflict,
            "Checkpoint receipt is invalid.",
        )
    })?;
    validate_receipt(repository, &receipt, &operation_id, &request_digest)?;
    Ok(
        serde_json::json!({"operation": "observe", "status": "found", "receipt": receipt, "receiptObjectOid": receipt_oid}),
    )
}

fn existing_receipt(
    repository: &Repository,
    operation_id: &str,
    digest: &str,
) -> Result<Option<MutationResult>> {
    let reference = receipt_ref(operation_id);
    let Some(receipt_oid) = try_resolve_ref(repository, &reference)? else {
        return Ok(None);
    };
    let bytes = git_bytes(
        repository,
        &["cat-file", "blob", &receipt_oid],
        None,
        MAX_GIT_OUTPUT_BYTES,
    )?
    .bytes;
    let receipt: Value = serde_json::from_slice(&bytes).map_err(|_| {
        CheckpointError::new(
            ErrorCode::OperationIdConflict,
            "Checkpoint receipt is invalid.",
        )
    })?;
    validate_receipt(repository, &receipt, operation_id, digest)?;
    let operation = match receipt.get("operation").and_then(Value::as_str) {
        Some("capture") => "capture",
        Some("restore") => "restore",
        Some("delete") => "delete",
        _ => {
            return Err(CheckpointError::new(
                ErrorCode::OperationIdConflict,
                "Checkpoint receipt is invalid.",
            ))
        }
    };
    Ok(Some(MutationResult {
        operation,
        receipt,
        receipt_object_oid: receipt_oid,
    }))
}

fn validate_receipt(
    repository: &Repository,
    receipt: &Value,
    operation_id: &str,
    digest: &str,
) -> Result<()> {
    validate_receipt_inner(repository, receipt, operation_id, digest).map_err(|_| {
        CheckpointError::new(
            ErrorCode::OperationIdConflict,
            "Operation identifier is already bound to another request.",
        )
    })
}

fn validate_receipt_inner(
    repository: &Repository,
    receipt: &Value,
    operation_id: &str,
    digest: &str,
) -> Result<()> {
    if receipt.get("operationId").and_then(Value::as_str) != Some(operation_id)
        || receipt.get("requestSha256").and_then(Value::as_str) != Some(digest)
        || receipt.get("receiptRef").and_then(Value::as_str)
            != Some(receipt_ref(operation_id).as_str())
        || receipt.get("repositoryFingerprint").and_then(Value::as_str)
            != Some(repository.binding.fingerprint.as_str())
        || receipt.get("status").and_then(Value::as_str) != Some("succeeded")
    {
        return Err(CheckpointError::new(
            ErrorCode::OperationIdConflict,
            "Operation identifier is already bound to another request.",
        ));
    }
    let operation = receipt
        .get("operation")
        .and_then(Value::as_str)
        .ok_or_else(operation_failed)?;
    match operation {
        "capture" => {
            require_exact_keys(
                receipt,
                &[
                    "operation",
                    "operationId",
                    "receiptRef",
                    "requestSha256",
                    "repositoryFingerprint",
                    "status",
                    "checkpointId",
                    "checkpointRef",
                    "checkpointOid",
                    "treeOid",
                ],
            )?;
            validate_checkpoint_receipt(repository, receipt)?;
            validate_object_id_for(
                repository,
                receipt
                    .get("treeOid")
                    .and_then(Value::as_str)
                    .ok_or_else(operation_failed)?,
            )?;
        }
        "restore" => {
            require_exact_keys(
                receipt,
                &[
                    "operation",
                    "operationId",
                    "receiptRef",
                    "requestSha256",
                    "repositoryFingerprint",
                    "status",
                    "checkpointId",
                    "checkpointRef",
                    "checkpointOid",
                ],
            )?;
            validate_checkpoint_receipt(repository, receipt)?;
        }
        "delete" => {
            require_exact_keys(
                receipt,
                &[
                    "operation",
                    "operationId",
                    "receiptRef",
                    "requestSha256",
                    "repositoryFingerprint",
                    "status",
                    "checkpoints",
                ],
            )?;
            let items = receipt
                .get("checkpoints")
                .and_then(Value::as_array)
                .ok_or_else(operation_failed)?;
            if items.is_empty() || items.len() > 256 {
                return Err(operation_failed());
            }
            let mut seen = std::collections::HashSet::new();
            for item in items {
                let status = item
                    .get("status")
                    .and_then(Value::as_str)
                    .ok_or_else(operation_failed)?;
                if status == "deleted" {
                    require_exact_keys(
                        item,
                        &[
                            "checkpointId",
                            "checkpointRef",
                            "status",
                            "deletedCheckpointOid",
                        ],
                    )?;
                    validate_object_id_for(
                        repository,
                        item.get("deletedCheckpointOid")
                            .and_then(Value::as_str)
                            .ok_or_else(operation_failed)?,
                    )?;
                } else if status == "already_absent" {
                    require_exact_keys(item, &["checkpointId", "checkpointRef", "status"])?;
                } else {
                    return Err(operation_failed());
                }
                let id = item
                    .get("checkpointId")
                    .and_then(Value::as_str)
                    .ok_or_else(operation_failed)?;
                validate_uuid(id)?;
                if !seen.insert(id)
                    || item.get("checkpointRef").and_then(Value::as_str)
                        != Some(checkpoint_ref(id).as_str())
                {
                    return Err(operation_failed());
                }
            }
        }
        _ => return Err(operation_failed()),
    }
    Ok(())
}

fn validate_checkpoint_receipt(repository: &Repository, receipt: &Value) -> Result<()> {
    let id = receipt
        .get("checkpointId")
        .and_then(Value::as_str)
        .ok_or_else(operation_failed)?;
    validate_uuid(id)?;
    if receipt.get("checkpointRef").and_then(Value::as_str) != Some(checkpoint_ref(id).as_str()) {
        return Err(operation_failed());
    }
    validate_object_id_for(
        repository,
        receipt
            .get("checkpointOid")
            .and_then(Value::as_str)
            .ok_or_else(operation_failed)?,
    )
}

fn require_exact_keys(value: &Value, expected: &[&str]) -> Result<()> {
    let object = value.as_object().ok_or_else(operation_failed)?;
    if object.len() != expected.len() || !expected.iter().all(|key| object.contains_key(*key)) {
        return Err(operation_failed());
    }
    Ok(())
}

fn write_receipt(repository: &Repository, receipt: &Value) -> Result<String> {
    let bytes = serde_json::to_vec(receipt).map_err(|_| operation_failed())?;
    let oid = git_stdout_with_env(
        &repository.git,
        Path::new(&repository.binding.worktree_root.canonical_path),
        &["hash-object", "-w", "--stdin"],
        None,
        128,
        &[],
        Some(&bytes),
    )?;
    validate_object_id_for(repository, &oid)?;
    Ok(oid)
}

fn update_refs(repository: &Repository, commands: &[String]) -> Result<()> {
    let mut input = String::from("start\n");
    for command in commands {
        input.push_str(command);
        input.push('\n');
    }
    input.push_str("prepare\ncommit\n");
    git_status(
        repository,
        &["update-ref", "--stdin", "--no-deref"],
        None,
        Some(input.as_bytes()),
    )
}

fn ensure_ref_missing(repository: &Repository, reference: &str) -> Result<()> {
    if try_resolve_ref(repository, reference)?.is_some() {
        Err(CheckpointError::new(
            ErrorCode::CheckpointExists,
            "Checkpoint already exists.",
        ))
    } else {
        Ok(())
    }
}

fn resolve_ref(repository: &Repository, reference: &str, code: ErrorCode) -> Result<String> {
    try_resolve_ref(repository, reference)?.ok_or_else(|| {
        CheckpointError::new(
            code,
            match code {
                ErrorCode::CheckpointNotFound => "Checkpoint was not found.",
                _ => "Checkpoint receipt was not found.",
            },
        )
    })
}

fn try_resolve_ref(repository: &Repository, reference: &str) -> Result<Option<String>> {
    let output = run_git(
        repository,
        &["rev-parse", "--verify", reference],
        None,
        None,
        MAX_GIT_OUTPUT_BYTES,
    )?;
    if !output.success {
        return Ok(None);
    }
    let value = decode_trimmed(output.bytes)?;
    validate_object_id_for(repository, &value)?;
    Ok(Some(value))
}

fn try_resolve_revision(repository: &Repository, revision: &str) -> Result<Option<String>> {
    let output = run_git(
        repository,
        &["rev-parse", "--verify", revision],
        None,
        None,
        MAX_GIT_OUTPUT_BYTES,
    )?;
    if !output.success {
        return Ok(None);
    }
    let value = decode_trimmed(output.bytes)?;
    validate_object_id_for(repository, &value)?;
    Ok(Some(value))
}

fn checkpoint_ref(checkpoint_id: &str) -> String {
    format!("refs/cocoa/checkpoints/v1/{checkpoint_id}")
}

fn ensure_no_external_filters(repository: &Repository) -> Result<()> {
    let output = run_git(
        repository,
        &["config", "--null", "--name-only", "--list"],
        None,
        None,
        MAX_GIT_OUTPUT_BYTES,
    )?;
    if !output.success || output.truncated {
        return Err(operation_failed());
    }
    for raw_name in output
        .bytes
        .split(|byte| *byte == 0)
        .filter(|name| !name.is_empty())
    {
        let name = std::str::from_utf8(raw_name).map_err(|_| operation_failed())?;
        let normalized = name.to_ascii_lowercase();
        if normalized.starts_with("filter.")
            && (normalized.ends_with(".clean")
                || normalized.ends_with(".smudge")
                || normalized.ends_with(".process"))
        {
            return Err(CheckpointError::new(
                ErrorCode::OperationFailed,
                "Repository content filters are unsupported.",
            ));
        }
    }
    Ok(())
}

fn validate_writable_metadata(
    repository: &Repository,
    writes_index: bool,
    checkpoint_ids: &[&str],
    operation_id: &str,
) -> Result<()> {
    let common = Dir::open_ambient_dir(&repository.common_dir, ambient_authority())
        .map_err(|_| operation_failed())?;
    let objects =
        super::open_child_directory(&common, "objects").map_err(|_| operation_failed())?;
    validate_directory_entries_nofollow(&objects, 512)?;
    let refs = ensure_child_directory(&common, "refs")?;
    let cocoa = ensure_child_directory(&refs, "cocoa")?;
    let checkpoints = ensure_child_directory(&cocoa, "checkpoints")?;
    let checkpoint_v1 = ensure_child_directory(&checkpoints, "v1")?;
    let receipts = ensure_child_directory(&cocoa, "checkpoint-receipts")?;
    let receipt_v1 = ensure_child_directory(&receipts, "v1")?;
    for checkpoint_id in checkpoint_ids {
        validate_optional_direct_ref(repository, &checkpoint_v1, checkpoint_id)?;
    }
    validate_optional_direct_ref(repository, &receipt_v1, operation_id)?;
    validate_optional_regular_file(&common, "packed-refs")?;
    validate_optional_cocoa_logs(&common, checkpoint_ids, operation_id)?;
    if writes_index {
        let git_directory = Dir::open_ambient_dir(
            &repository.binding.git_directory_root.canonical_path,
            ambient_authority(),
        )
        .map_err(|_| operation_failed())?;
        validate_optional_regular_file(&git_directory, "index")?;
        validate_optional_regular_file(&git_directory, "index.lock")?;
    }
    Ok(())
}

fn validate_read_metadata(
    repository: &Repository,
    checkpoint_ids: &[&str],
    operation_id: Option<&str>,
) -> Result<()> {
    let common = Dir::open_ambient_dir(&repository.common_dir, ambient_authority())
        .map_err(|_| operation_failed())?;
    let objects =
        super::open_child_directory(&common, "objects").map_err(|_| operation_failed())?;
    validate_directory_entries_nofollow(&objects, 512)?;
    validate_optional_regular_file(&common, "packed-refs")?;
    let Some(refs) = optional_child_directory(&common, "refs")? else {
        return Ok(());
    };
    let Some(cocoa) = optional_child_directory(&refs, "cocoa")? else {
        return Ok(());
    };
    if !checkpoint_ids.is_empty() {
        if let Some(checkpoints) = optional_child_directory(&cocoa, "checkpoints")? {
            if let Some(v1) = optional_child_directory(&checkpoints, "v1")? {
                for checkpoint_id in checkpoint_ids {
                    validate_optional_direct_ref(repository, &v1, checkpoint_id)?;
                }
            }
        }
    }
    if let Some(operation_id) = operation_id {
        if let Some(receipts) = optional_child_directory(&cocoa, "checkpoint-receipts")? {
            if let Some(v1) = optional_child_directory(&receipts, "v1")? {
                validate_optional_direct_ref(repository, &v1, operation_id)?;
            }
        }
    }
    Ok(())
}

fn validate_optional_cocoa_logs(
    common: &Dir,
    checkpoint_ids: &[&str],
    operation_id: &str,
) -> Result<()> {
    let Some(logs) = optional_child_directory(common, "logs")? else {
        return Ok(());
    };
    let Some(refs) = optional_child_directory(&logs, "refs")? else {
        return Ok(());
    };
    let Some(cocoa) = optional_child_directory(&refs, "cocoa")? else {
        return Ok(());
    };
    if let Some(checkpoints) = optional_child_directory(&cocoa, "checkpoints")? {
        if let Some(v1) = optional_child_directory(&checkpoints, "v1")? {
            for checkpoint_id in checkpoint_ids {
                validate_optional_regular_file(&v1, checkpoint_id)?;
            }
        }
    }
    if let Some(receipts) = optional_child_directory(&cocoa, "checkpoint-receipts")? {
        if let Some(v1) = optional_child_directory(&receipts, "v1")? {
            validate_optional_regular_file(&v1, operation_id)?;
        }
    }
    Ok(())
}

fn optional_child_directory(parent: &Dir, name: &str) -> Result<Option<Dir>> {
    match parent.symlink_metadata(name) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err(operation_failed()),
        Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {
            super::open_child_directory(parent, name)
                .map(Some)
                .map_err(|_| operation_failed())
        }
        Ok(_) => Err(operation_failed()),
    }
}

fn ensure_child_directory(parent: &Dir, name: &str) -> Result<Dir> {
    match parent.create_dir(name) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(_) => return Err(operation_failed()),
    }
    super::open_child_directory(parent, name).map_err(|_| operation_failed())
}

fn validate_optional_regular_file(directory: &Dir, name: &str) -> Result<()> {
    match directory.symlink_metadata(name) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err(operation_failed()),
        Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink() => {
            super::open_nofollow(directory, name, false)
                .map(|_| ())
                .map_err(|_| operation_failed())
        }
        Ok(_) => Err(operation_failed()),
    }
}

fn validate_optional_direct_ref(
    repository: &Repository,
    directory: &Dir,
    name: &str,
) -> Result<()> {
    match directory.symlink_metadata(name) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err(operation_failed()),
        Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink() => {
            let mut file =
                super::open_nofollow(directory, name, false).map_err(|_| operation_failed())?;
            let mut bytes = Vec::with_capacity(65);
            Read::by_ref(&mut file)
                .take(66)
                .read_to_end(&mut bytes)
                .map_err(|_| operation_failed())?;
            if bytes.len() > 65 {
                return Err(operation_failed());
            }
            let oid = std::str::from_utf8(&bytes)
                .map_err(|_| operation_failed())?
                .trim_end_matches(['\n', '\r']);
            validate_object_id_for(repository, oid)
        }
        Ok(_) => Err(operation_failed()),
    }
}

fn validate_directory_entries_nofollow(directory: &Dir, max_entries: usize) -> Result<()> {
    let mut observed = 0_usize;
    let entries = directory.entries().map_err(|_| operation_failed())?;
    for entry in entries {
        observed = observed.saturating_add(1);
        if observed > max_entries {
            return Err(operation_failed());
        }
        let name = entry
            .map_err(|_| operation_failed())?
            .file_name()
            .into_string()
            .map_err(|_| operation_failed())?;
        super::validate_entry_name(&name).map_err(|_| operation_failed())?;
        let metadata = directory
            .symlink_metadata(&name)
            .map_err(|_| operation_failed())?;
        if metadata.file_type().is_symlink() || (!metadata.is_dir() && !metadata.is_file()) {
            return Err(operation_failed());
        }
    }
    Ok(())
}
fn receipt_ref(operation_id: &str) -> String {
    format!("refs/cocoa/checkpoint-receipts/v1/{operation_id}")
}

fn request_digest(bytes: &[u8]) -> Result<String> {
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

fn validate_uuid(value: &str) -> Result<()> {
    let bytes = value.as_bytes();
    if bytes.len() != 36
        || ![8, 13, 18, 23].iter().all(|index| bytes[*index] == b'-')
        || bytes.iter().enumerate().any(|(index, byte)| {
            ![8, 13, 18, 23].contains(&index) && !matches!(byte, b'0'..=b'9' | b'a'..=b'f')
        })
        || !matches!(bytes[14], b'1'..=b'8')
        || !matches!(bytes[19], b'8' | b'9' | b'a' | b'b')
    {
        return Err(CheckpointError::new(
            ErrorCode::InvalidRequest,
            "Checkpoint identifier is invalid.",
        ));
    }
    Ok(())
}

fn validate_object_id_for(repository: &Repository, value: &str) -> Result<()> {
    let expected_length = if repository.binding.object_format == "sha1" {
        40
    } else {
        64
    };
    if value.len() != expected_length
        || !value
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
    {
        return Err(operation_failed());
    }
    Ok(())
}

fn validate_hex_digest(value: &str) -> Result<()> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
    {
        return Err(CheckpointError::new(
            ErrorCode::InvalidRequest,
            "Request digest is invalid.",
        ));
    }
    Ok(())
}

fn validate_absolute_normalized(value: &str) -> Result<()> {
    if value.is_empty()
        || value.len() > MAX_PATH_BYTES
        || !value.starts_with('/')
        || value.contains('\0')
        || value.contains('\\')
        || (value != "/"
            && value[1..]
                .split('/')
                .any(|part| part.is_empty() || part == "." || part == ".."))
    {
        return Err(CheckpointError::new(
            ErrorCode::InvalidRequest,
            "Path must be an absolute normalized POSIX path.",
        ));
    }
    Ok(())
}

fn validate_git_executable(value: &str) -> Result<String> {
    validate_absolute_normalized(value).map_err(|_| {
        CheckpointError::new(
            ErrorCode::InvalidGitExecutable,
            "Git executable path is invalid.",
        )
    })?;
    if value == "/" {
        return Err(CheckpointError::new(
            ErrorCode::InvalidGitExecutable,
            "Git executable path is invalid.",
        ));
    }
    let components = super::split_root(value).map_err(|_| {
        CheckpointError::new(
            ErrorCode::InvalidGitExecutable,
            "Git executable path is invalid.",
        )
    })?;
    let (leaf, parents) = components.split_last().ok_or_else(|| {
        CheckpointError::new(
            ErrorCode::InvalidGitExecutable,
            "Git executable path is invalid.",
        )
    })?;
    let ambient =
        Dir::open_ambient_dir("/", ambient_authority()).map_err(|_| operation_failed())?;
    let parent = super::open_relative_directory(&ambient, parents).map_err(|_| {
        CheckpointError::new(
            ErrorCode::InvalidGitExecutable,
            "Git executable is unavailable.",
        )
    })?;
    let file = super::open_nofollow(&parent, leaf, false).map_err(|_| {
        CheckpointError::new(
            ErrorCode::InvalidGitExecutable,
            "Git executable is unavailable.",
        )
    })?;
    if !file.metadata().map_err(|_| operation_failed())?.is_file() {
        return Err(CheckpointError::new(
            ErrorCode::InvalidGitExecutable,
            "Git executable is unavailable.",
        ));
    }
    let canonical = fs::canonicalize(value).map_err(|_| operation_failed())?;
    if canonical != Path::new(value) {
        return Err(CheckpointError::new(
            ErrorCode::InvalidGitExecutable,
            "Git executable path may not traverse symbolic links.",
        ));
    }
    Ok(value.to_owned())
}

fn directory_identity(value: &str, code: ErrorCode) -> Result<RootIdentity> {
    validate_absolute_normalized(value)
        .map_err(|_| CheckpointError::new(code, "Repository path is invalid."))?;
    let components = super::split_root(value)
        .map_err(|_| CheckpointError::new(code, "Repository path is invalid."))?;
    let ambient =
        Dir::open_ambient_dir("/", ambient_authority()).map_err(|_| operation_failed())?;
    let directory = super::open_relative_directory(&ambient, &components)
        .map_err(|_| CheckpointError::new(code, "Repository path could not be opened."))?;
    let metadata = directory.dir_metadata().map_err(|_| operation_failed())?;
    let canonical = fs::canonicalize(value).map_err(|_| operation_failed())?;
    if canonical != Path::new(value) {
        return Err(CheckpointError::new(
            code,
            "Repository path may not traverse symbolic links.",
        ));
    }
    Ok(RootIdentity {
        canonical_path: value.to_owned(),
        device: metadata.dev().to_string(),
        inode: metadata.ino().to_string(),
    })
}

struct GitOutput {
    success: bool,
    bytes: Vec<u8>,
    truncated: bool,
}

fn git_stdout(
    git: &str,
    worktree: &Path,
    args: &[&str],
    index: Option<&Path>,
    max: usize,
) -> Result<String> {
    let output = run_git_parts(git, worktree, args, index, None, max, &[])?;
    if !output.success {
        return Err(CheckpointError::new(
            ErrorCode::NotARepository,
            "Git repository operation failed.",
        ));
    }
    decode_trimmed(output.bytes)
}

fn git_stdout_with_env(
    git: &str,
    worktree: &Path,
    args: &[&str],
    index: Option<&Path>,
    max: usize,
    env: &[(&str, &str)],
    stdin: Option<&[u8]>,
) -> Result<String> {
    let output = run_git_parts(git, worktree, args, index, stdin, max, env)?;
    if !output.success || output.truncated {
        return Err(operation_failed());
    }
    decode_trimmed(output.bytes)
}

fn git_status(
    repository: &Repository,
    args: &[&str],
    index: Option<&Path>,
    stdin: Option<&[u8]>,
) -> Result<()> {
    let output = run_git(repository, args, index, stdin, MAX_GIT_OUTPUT_BYTES)?;
    if output.success {
        Ok(())
    } else {
        Err(operation_failed())
    }
}

fn git_bounded(
    repository: &Repository,
    args: &[&str],
    index: Option<&Path>,
    max: usize,
) -> Result<GitOutput> {
    let output = run_git(repository, args, index, None, max)?;
    if output.success {
        Ok(output)
    } else {
        Err(operation_failed())
    }
}

fn git_bytes(
    repository: &Repository,
    args: &[&str],
    index: Option<&Path>,
    max: usize,
) -> Result<GitOutput> {
    git_bounded(repository, args, index, max)
}

fn run_git(
    repository: &Repository,
    args: &[&str],
    index: Option<&Path>,
    stdin: Option<&[u8]>,
    max: usize,
) -> Result<GitOutput> {
    run_git_parts(
        &repository.git,
        Path::new(&repository.binding.worktree_root.canonical_path),
        args,
        index,
        stdin,
        max,
        &[],
    )
}

fn run_git_parts(
    git: &str,
    worktree: &Path,
    args: &[&str],
    index: Option<&Path>,
    stdin: Option<&[u8]>,
    max: usize,
    extra_env: &[(&str, &str)],
) -> Result<GitOutput> {
    let mut command = Command::new(git);
    command
        .env_clear()
        .env("HOME", "/")
        .env("LANG", "C")
        .env("LC_ALL", "C")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GCM_INTERACTIVE", "Never")
        .env("GIT_PAGER", "cat")
        .env("PAGER", "cat")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .arg("--no-optional-locks")
        .args([
            "-c",
            "core.hooksPath=/dev/null",
            "-c",
            "credential.helper=",
            "-c",
            "core.fsmonitor=false",
            "-c",
            "core.untrackedCache=false",
            "-c",
            "core.logAllRefUpdates=false",
            "-c",
            "diff.external=",
            "-c",
            "pager.diff=false",
            "-c",
            "submodule.recurse=false",
            "-c",
            "fetch.recurseSubmodules=false",
            "-c",
            "protocol.allow=never",
            "-C",
        ])
        .arg(worktree)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .stdin(if stdin.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        });
    if let Some(path) = index {
        command.env("GIT_INDEX_FILE", path);
    }
    for (name, value) in extra_env {
        command.env(name, value);
    }
    let mut child = command.spawn().map_err(|_| operation_failed())?;
    if let Some(input) = stdin {
        child
            .stdin
            .take()
            .ok_or_else(operation_failed)?
            .write_all(input)
            .map_err(|_| operation_failed())?;
    }
    let mut stdout = child.stdout.take().ok_or_else(operation_failed)?;
    let mut bytes = Vec::with_capacity(max.min(64 * 1024));
    let mut byte_length = 0_u64;
    let mut buffer = [0_u8; 16 * 1024];
    loop {
        let count = stdout.read(&mut buffer).map_err(|_| operation_failed())?;
        if count == 0 {
            break;
        }
        byte_length = byte_length.saturating_add(count as u64);
        if bytes.len() < max {
            let keep = count.min(max - bytes.len());
            bytes.extend_from_slice(&buffer[..keep]);
        }
    }
    let status = child.wait().map_err(|_| operation_failed())?;
    Ok(GitOutput {
        success: status.success(),
        truncated: byte_length > max as u64,
        bytes,
    })
}

fn decode_trimmed(bytes: Vec<u8>) -> Result<String> {
    let value = String::from_utf8(bytes).map_err(|_| operation_failed())?;
    Ok(value.trim_end_matches(['\n', '\r']).to_owned())
}

fn success<T: Serialize>(result: T) -> Result<Value> {
    serde_json::to_value(SuccessResponse {
        protocol: PROTOCOL,
        ok: true,
        result,
    })
    .map_err(|_| operation_failed())
}

fn frame_error(error: CheckpointError) -> Vec<u8> {
    let retryable = matches!(error.code, ErrorCode::RepositoryBusy);
    let response = ErrorResponse {
        protocol: PROTOCOL,
        ok: false,
        error: ErrorBody {
            code: error.code,
            message: error.message,
            retryable,
        },
    };
    let value = serde_json::to_value(response).unwrap_or_else(|_| serde_json::json!({"protocol": PROTOCOL, "ok": false, "error": {"code": "operation_failed", "message": "Checkpoint helper operation failed."}}));
    frame_value(value)
}

fn frame_value(value: Value) -> Vec<u8> {
    let payload = ascii_json(&value).unwrap_or_else(|_| br#"{"protocol":"cocoa.checkpoint.v1","ok":false,"error":{"code":"operation_failed","message":"Checkpoint helper operation failed."}}"#.to_vec());
    if payload.len() > MAX_RESPONSE_BYTES {
        return frame_error(CheckpointError::new(
            ErrorCode::ResponseTooLarge,
            "Checkpoint response exceeded its byte limit.",
        ));
    }
    let digest = Sha256::digest(&payload);
    let header = format!("CCH1 {} {digest:x}\n", payload.len());
    let mut frame = Vec::with_capacity(header.len() + payload.len());
    frame.extend_from_slice(header.as_bytes());
    frame.extend_from_slice(&payload);
    frame
}

fn ascii_json(value: &Value) -> Result<Vec<u8>> {
    let json = serde_json::to_string(value).map_err(|_| operation_failed())?;
    let mut ascii = String::with_capacity(json.len());
    for character in json.chars() {
        if character.is_ascii() {
            ascii.push(character);
        } else {
            for unit in character.encode_utf16(&mut [0; 2]) {
                use std::fmt::Write as _;
                write!(&mut ascii, "\\u{unit:04x}").map_err(|_| operation_failed())?;
            }
        }
    }
    Ok(ascii.into_bytes())
}

fn operation_failed() -> CheckpointError {
    CheckpointError::new(
        ErrorCode::OperationFailed,
        "Checkpoint helper operation failed.",
    )
}
