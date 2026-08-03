#![forbid(unsafe_code)]

#[cfg(not(unix))]
compile_error!("cocoa-workspace-helper v1 supports POSIX hosts only");

use std::collections::VecDeque;
use std::ffi::OsString;
use std::fs;
use std::io::{self, Read};
use std::time::{SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use cap_fs_ext::{FollowSymlinks, OpenOptionsFollowExt, OpenOptionsMaybeDirExt};
use cap_std::ambient_authority;
use cap_std::fs::{Dir, Metadata, MetadataExt, OpenOptions};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

const PROTOCOL: u8 = 1;
const MAX_PATH_BYTES: usize = 4_096;
const MAX_READ_BYTES: usize = 1_024 * 1_024;
const MAX_LIST_ENTRIES: usize = 25_000;
const MAX_LIST_DEPTH: usize = 64;
const MAX_LIST_DIRECTORIES: usize = 10_000;
const MAX_RESPONSE_BYTES: usize = 8 * 1_024 * 1_024;
const MAX_BROWSE_ENTRIES: usize = 10_000;
const MAX_BROWSE_RESPONSE_BYTES: usize = 4 * 1_024 * 1_024;
const MAX_ENTRY_NAME_CHARS: usize = 1_024;
const MAX_ENCODED_REQUEST_BYTES: usize = 131_072;
const MAX_DECODED_REQUEST_BYTES: usize = 65_536;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Debug)]
struct HelperError {
    code: ErrorCode,
    message: &'static str,
}

impl HelperError {
    const fn new(code: ErrorCode, message: &'static str) -> Self {
        Self { code, message }
    }
}

type HelperResult<T> = Result<T, HelperError>;

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
enum ErrorCode {
    UnsupportedProtocol,
    UnsupportedOperation,
    InvalidRoot,
    InvalidPath,
    PathNotFound,
    PathNotFile,
    PathNotDirectory,
    PathIsSymlink,
    LimitExceeded,
    OperationFailed,
}

#[derive(Debug, Serialize)]
struct ErrorBody {
    code: ErrorCode,
    message: &'static str,
}

#[derive(Debug, Serialize)]
struct ErrorResponse {
    protocol: u8,
    ok: bool,
    error: ErrorBody,
}

#[derive(Debug, Serialize)]
struct SuccessResponse<T> {
    protocol: u8,
    ok: bool,
    result: T,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RootIdentity {
    canonical_root: String,
    device: String,
    inode: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ListLimits {
    max_entries: usize,
    max_depth: usize,
    max_directories: usize,
    max_response_bytes: usize,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
enum BrowseLocator {
    Absolute {
        path: String,
    },
    Home {
        #[serde(rename = "relativePath")]
        relative_path: String,
    },
}

#[derive(Debug, Deserialize)]
#[serde(tag = "operation", rename_all = "lowercase", deny_unknown_fields)]
enum Request {
    Probe {
        protocol: u8,
    },
    Validate {
        protocol: u8,
        root: String,
    },
    Stat {
        protocol: u8,
        root: String,
        #[serde(rename = "expectedRoot")]
        expected_root: RootIdentity,
        #[serde(rename = "relativePath")]
        relative_path: String,
    },
    List {
        protocol: u8,
        root: String,
        #[serde(rename = "expectedRoot")]
        expected_root: RootIdentity,
        #[serde(rename = "relativePath")]
        relative_path: String,
        limits: ListLimits,
    },
    Read {
        protocol: u8,
        root: String,
        #[serde(rename = "expectedRoot")]
        expected_root: RootIdentity,
        #[serde(rename = "relativePath")]
        relative_path: String,
        #[serde(rename = "maxBytes")]
        max_bytes: usize,
    },
    Browse {
        protocol: u8,
        locator: BrowseLocator,
        #[serde(rename = "maxEntries")]
        max_entries: usize,
        #[serde(rename = "maxResponseBytes")]
        max_response_bytes: usize,
    },
}

impl Request {
    fn protocol(&self) -> u8 {
        match self {
            Self::Probe { protocol }
            | Self::Validate { protocol, .. }
            | Self::Stat { protocol, .. }
            | Self::List { protocol, .. }
            | Self::Read { protocol, .. }
            | Self::Browse { protocol, .. } => *protocol,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProbeResult {
    operation: &'static str,
    implementation: &'static str,
    capabilities: [&'static str; 6],
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceMetadata {
    kind: EntryKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    size: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    created_at_ms: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    modified_at_ms: Option<i64>,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "lowercase")]
enum EntryKind {
    File,
    Directory,
    Symlink,
    Other,
}

#[derive(Debug, Serialize)]
struct ValidateResult {
    operation: &'static str,
    root: RootIdentity,
    metadata: WorkspaceMetadata,
}

#[derive(Debug, Serialize)]
struct StatResult {
    operation: &'static str,
    metadata: WorkspaceMetadata,
}

#[derive(Clone, Debug, Serialize)]
struct ListEntry {
    path: String,
    kind: EntryKind,
}

#[derive(Debug, Serialize)]
struct ListResult {
    operation: &'static str,
    entries: Vec<ListEntry>,
    truncated: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ReadResult {
    operation: &'static str,
    data_base64: String,
    byte_length: u64,
    truncated: bool,
}

#[derive(Clone, Debug, Serialize)]
struct BrowseEntry {
    name: String,
    kind: EntryKind,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BrowseResult {
    operation: &'static str,
    directory_path: String,
    parent_path: Option<String>,
    entries: Vec<BrowseEntry>,
    truncated: bool,
}

struct OpenRoot {
    dir: Dir,
    identity: RootIdentity,
    metadata: Metadata,
}

pub fn run_argv(args: Vec<OsString>) -> Vec<u8> {
    let outcome = dispatch_argv(args);
    match outcome {
        Ok((response, response_limit)) => frame_with_limit(response, response_limit),
        Err(error) => frame_error(error),
    }
}

pub fn internal_error_frame() -> Vec<u8> {
    frame_error(HelperError::new(
        ErrorCode::OperationFailed,
        "Workspace helper operation failed.",
    ))
}

fn dispatch_argv(args: Vec<OsString>) -> HelperResult<(Value, usize)> {
    if args.len() != 1 {
        return Err(HelperError::new(
            ErrorCode::InvalidPath,
            "Expected one encoded helper request.",
        ));
    }
    let encoded = args.into_iter().next().expect("length checked");
    let encoded = encoded.to_str().ok_or_else(|| {
        HelperError::new(
            ErrorCode::OperationFailed,
            "Encoded request is not valid UTF-8.",
        )
    })?;
    if encoded.len() > MAX_ENCODED_REQUEST_BYTES {
        return Err(HelperError::new(
            ErrorCode::LimitExceeded,
            "Encoded request is too large.",
        ));
    }
    let decoded = BASE64
        .decode(encoded.as_bytes())
        .map_err(|_| HelperError::new(ErrorCode::OperationFailed, "Encoded request is invalid."))?;
    if decoded.len() > MAX_DECODED_REQUEST_BYTES {
        return Err(HelperError::new(
            ErrorCode::LimitExceeded,
            "Decoded request is too large.",
        ));
    }
    let value: Value = serde_json::from_slice(&decoded).map_err(|_| {
        HelperError::new(
            ErrorCode::OperationFailed,
            "Helper request is invalid JSON.",
        )
    })?;
    let object = value.as_object().ok_or_else(|| {
        HelperError::new(
            ErrorCode::OperationFailed,
            "Helper request must be an object.",
        )
    })?;
    if object.get("protocol").and_then(Value::as_u64) != Some(u64::from(PROTOCOL)) {
        return Err(HelperError::new(
            ErrorCode::UnsupportedProtocol,
            "Unsupported workspace helper protocol.",
        ));
    }
    match object.get("operation").and_then(Value::as_str) {
        Some("probe" | "validate" | "stat" | "list" | "read" | "browse") => {}
        _ => {
            return Err(HelperError::new(
                ErrorCode::UnsupportedOperation,
                "Unsupported workspace helper operation.",
            ));
        }
    }
    let request: Request = serde_json::from_value(value).map_err(|_| {
        HelperError::new(
            ErrorCode::OperationFailed,
            "Helper request shape is invalid.",
        )
    })?;
    if request.protocol() != PROTOCOL {
        return Err(HelperError::new(
            ErrorCode::UnsupportedProtocol,
            "Unsupported workspace helper protocol.",
        ));
    }
    dispatch(request)
}

fn dispatch(request: Request) -> HelperResult<(Value, usize)> {
    match request {
        Request::Probe { .. } => success_value(
            ProbeResult {
                operation: "probe",
                implementation: "cocoa-workspace-helper-rust",
                capabilities: ["probe", "validate", "stat", "list", "read", "browse"],
            },
            MAX_RESPONSE_BYTES,
        ),
        Request::Validate { root, .. } => {
            let opened = open_root(&root)?;
            let result = ValidateResult {
                operation: "validate",
                root: opened.identity,
                metadata: metadata(&opened.metadata)?,
            };
            success_value(result, MAX_RESPONSE_BYTES)
        }
        Request::Stat {
            root,
            expected_root,
            relative_path,
            ..
        } => {
            let root = verify_root(&root, &expected_root)?;
            let components = split_relative(&relative_path)?;
            let value = stat_relative(&root.dir, &components)?;
            success_value(
                StatResult {
                    operation: "stat",
                    metadata: metadata(&value)?,
                },
                MAX_RESPONSE_BYTES,
            )
        }
        Request::List {
            root,
            expected_root,
            relative_path,
            limits,
            ..
        } => {
            validate_list_limits(&limits)?;
            let root = verify_root(&root, &expected_root)?;
            let components = split_relative(&relative_path)?;
            let directory = open_relative_directory(&root.dir, &components)?;
            let result = list_directory(&directory, &limits)?;
            let value = success_json(result)?;
            let value = fit_list_response(value, limits.max_response_bytes)?;
            Ok((value, limits.max_response_bytes))
        }
        Request::Read {
            root,
            expected_root,
            relative_path,
            max_bytes,
            ..
        } => {
            if max_bytes == 0 || max_bytes > MAX_READ_BYTES {
                return Err(HelperError::new(
                    ErrorCode::LimitExceeded,
                    "Invalid read byte limit.",
                ));
            }
            let root = verify_root(&root, &expected_root)?;
            let components = split_relative(&relative_path)?;
            let result = read_file(&root.dir, &components, max_bytes)?;
            success_value(result, MAX_RESPONSE_BYTES)
        }
        Request::Browse {
            locator,
            max_entries,
            max_response_bytes,
            ..
        } => browse(locator, max_entries, max_response_bytes),
    }
}

fn browse(
    locator: BrowseLocator,
    max_entries: usize,
    max_response_bytes: usize,
) -> HelperResult<(Value, usize)> {
    if max_entries == 0 || max_entries > MAX_BROWSE_ENTRIES {
        return Err(HelperError::new(
            ErrorCode::LimitExceeded,
            "Invalid browse entry limit.",
        ));
    }
    if max_response_bytes == 0 || max_response_bytes > MAX_BROWSE_RESPONSE_BYTES {
        return Err(HelperError::new(
            ErrorCode::LimitExceeded,
            "Invalid browse response byte limit.",
        ));
    }

    let (directory_path, components) = resolve_browse_locator(locator)?;
    let ambient_root = Dir::open_ambient_dir("/", ambient_authority()).map_err(|_| {
        HelperError::new(
            ErrorCode::OperationFailed,
            "Provider-host filesystem root could not be opened.",
        )
    })?;
    let directory = open_owned_relative_directory(&ambient_root, &components)?;
    let result = browse_directory(&directory, directory_path, max_entries)?;
    let value = fit_browse_response(success_json(result)?, max_response_bytes)?;
    Ok((value, max_response_bytes))
}

fn resolve_browse_locator(locator: BrowseLocator) -> HelperResult<(String, Vec<String>)> {
    match locator {
        BrowseLocator::Absolute { path } => {
            let components = split_browse_absolute(&path, ErrorCode::InvalidPath)?;
            Ok((path, components))
        }
        BrowseLocator::Home { relative_path } => {
            let home = std::env::var("HOME").map_err(|_| {
                HelperError::new(
                    ErrorCode::InvalidRoot,
                    "Provider-host home directory is unavailable.",
                )
            })?;
            let mut components = split_browse_absolute(&home, ErrorCode::InvalidRoot)?;
            let descendants = split_relative(&relative_path)?;
            let directory_path = if relative_path.is_empty() {
                home
            } else if home == "/" {
                format!("/{relative_path}")
            } else {
                format!("{home}/{relative_path}")
            };
            if directory_path.len() > MAX_PATH_BYTES {
                return Err(HelperError::new(
                    ErrorCode::InvalidPath,
                    "Resolved browse path is too long.",
                ));
            }
            components.extend(descendants.into_iter().map(str::to_owned));
            Ok((directory_path, components))
        }
    }
}

fn split_browse_absolute(path: &str, code: ErrorCode) -> HelperResult<Vec<String>> {
    split_root(path)
        .map(|components| components.into_iter().map(str::to_owned).collect())
        .map_err(|_| {
            HelperError::new(
                code,
                "Browse path must be an absolute normalized POSIX path.",
            )
        })
}

fn validate_list_limits(limits: &ListLimits) -> HelperResult<()> {
    if limits.max_entries == 0 || limits.max_entries > MAX_LIST_ENTRIES {
        return Err(HelperError::new(
            ErrorCode::LimitExceeded,
            "Invalid directory entry limit.",
        ));
    }
    if limits.max_depth > MAX_LIST_DEPTH
        || limits.max_directories == 0
        || limits.max_directories > MAX_LIST_DIRECTORIES
        || limits.max_response_bytes == 0
        || limits.max_response_bytes > MAX_RESPONSE_BYTES
    {
        return Err(HelperError::new(
            ErrorCode::LimitExceeded,
            "Invalid directory listing limit.",
        ));
    }
    Ok(())
}

fn split_root(root: &str) -> HelperResult<Vec<&str>> {
    if root.is_empty()
        || root.len() > MAX_PATH_BYTES
        || !root.starts_with('/')
        || root.contains('\0')
        || root.contains('\\')
    {
        return Err(HelperError::new(
            ErrorCode::InvalidRoot,
            "Root must be an absolute normalized POSIX path.",
        ));
    }
    if root == "/" {
        return Ok(Vec::new());
    }
    let components: Vec<_> = root[1..].split('/').collect();
    if components
        .iter()
        .any(|component| component.is_empty() || *component == "." || *component == "..")
    {
        return Err(HelperError::new(
            ErrorCode::InvalidRoot,
            "Root must be an absolute normalized POSIX path.",
        ));
    }
    Ok(components)
}

fn split_relative(path: &str) -> HelperResult<Vec<&str>> {
    if path.len() > MAX_PATH_BYTES
        || path.starts_with('/')
        || path.contains('\0')
        || path.contains('\\')
    {
        return Err(HelperError::new(
            ErrorCode::InvalidPath,
            "Path must be a normalized relative POSIX path.",
        ));
    }
    if path.is_empty() {
        return Ok(Vec::new());
    }
    let components: Vec<_> = path.split('/').collect();
    if components
        .iter()
        .any(|component| component.is_empty() || *component == "." || *component == "..")
    {
        return Err(HelperError::new(
            ErrorCode::InvalidPath,
            "Path must be a normalized relative POSIX path.",
        ));
    }
    Ok(components)
}

fn open_root(configured_root: &str) -> HelperResult<OpenRoot> {
    split_root(configured_root)?;
    let canonical = fs::canonicalize(configured_root).map_err(|_| {
        HelperError::new(
            ErrorCode::InvalidRoot,
            "Workspace root could not be opened.",
        )
    })?;
    let canonical_string = canonical.to_str().ok_or_else(|| {
        HelperError::new(ErrorCode::InvalidRoot, "Workspace root is not valid UTF-8.")
    })?;
    split_root(canonical_string)?;
    let dir = Dir::open_ambient_dir(&canonical, ambient_authority()).map_err(|_| {
        HelperError::new(
            ErrorCode::InvalidRoot,
            "Workspace root could not be opened.",
        )
    })?;
    let value = dir.dir_metadata().map_err(|_| {
        HelperError::new(
            ErrorCode::InvalidRoot,
            "Workspace root metadata is unavailable.",
        )
    })?;
    if !value.is_dir() {
        return Err(HelperError::new(
            ErrorCode::InvalidRoot,
            "Workspace root is not a directory.",
        ));
    }
    let identity = RootIdentity {
        canonical_root: canonical_string.to_owned(),
        device: value.dev().to_string(),
        inode: value.ino().to_string(),
    };
    Ok(OpenRoot {
        dir,
        identity,
        metadata: value,
    })
}

fn verify_root(root: &str, expected: &RootIdentity) -> HelperResult<OpenRoot> {
    validate_expected_identity(expected)?;
    let opened = open_root(root)?;
    if opened.identity != *expected {
        return Err(HelperError::new(
            ErrorCode::InvalidRoot,
            "Workspace root identity changed.",
        ));
    }
    Ok(opened)
}

fn validate_expected_identity(identity: &RootIdentity) -> HelperResult<()> {
    split_root(&identity.canonical_root)?;
    for component in [&identity.device, &identity.inode] {
        if component.is_empty()
            || component.len() > 64
            || !component.bytes().all(|byte| byte.is_ascii_digit())
        {
            return Err(HelperError::new(
                ErrorCode::InvalidRoot,
                "Workspace root identity is invalid.",
            ));
        }
    }
    Ok(())
}

fn open_nofollow(
    parent: &Dir,
    component: &str,
    directory: bool,
) -> HelperResult<cap_std::fs::File> {
    let before = parent
        .symlink_metadata(component)
        .map_err(|error| map_io_error(error, ErrorCode::OperationFailed))?;
    if before.file_type().is_symlink() {
        return Err(HelperError::new(
            ErrorCode::PathIsSymlink,
            "Symbolic-link traversal is forbidden.",
        ));
    }
    if directory && !before.is_dir() {
        return Err(HelperError::new(
            ErrorCode::PathNotDirectory,
            "Path is not a directory.",
        ));
    }
    if !directory && !before.is_file() {
        return Err(HelperError::new(
            ErrorCode::PathNotFile,
            "Path is not a regular file.",
        ));
    }

    let mut options = OpenOptions::new();
    options
        .read(true)
        .follow(FollowSymlinks::No)
        .maybe_dir(directory);
    let file = parent.open_with(component, &options).map_err(|error| {
        if parent
            .symlink_metadata(component)
            .is_ok_and(|metadata| metadata.file_type().is_symlink())
        {
            HelperError::new(
                ErrorCode::PathIsSymlink,
                "Symbolic-link traversal is forbidden.",
            )
        } else {
            map_io_error(error, ErrorCode::OperationFailed)
        }
    })?;
    let after = file
        .metadata()
        .map_err(|error| map_io_error(error, ErrorCode::OperationFailed))?;
    if directory && !after.is_dir() {
        return Err(HelperError::new(
            ErrorCode::PathNotDirectory,
            "Path is not a directory.",
        ));
    }
    if !directory && !after.is_file() {
        return Err(HelperError::new(
            ErrorCode::PathNotFile,
            "Path is not a regular file.",
        ));
    }
    Ok(file)
}

fn open_child_directory(parent: &Dir, component: &str) -> HelperResult<Dir> {
    let file = open_nofollow(parent, component, true)?;
    Ok(Dir::from_std_file(file.into_std()))
}

fn open_relative_directory(root: &Dir, components: &[&str]) -> HelperResult<Dir> {
    let mut current = root.try_clone().map_err(|_| {
        HelperError::new(
            ErrorCode::OperationFailed,
            "Workspace root could not be duplicated.",
        )
    })?;
    for component in components {
        current = open_child_directory(&current, component)?;
    }
    Ok(current)
}

fn open_owned_relative_directory(root: &Dir, components: &[String]) -> HelperResult<Dir> {
    let borrowed: Vec<_> = components.iter().map(String::as_str).collect();
    open_relative_directory(root, &borrowed)
}

fn open_parent<'a>(root: &Dir, components: &'a [&'a str]) -> HelperResult<(Dir, Option<&'a str>)> {
    match components.split_last() {
        None => Ok((open_relative_directory(root, &[])?, None)),
        Some((leaf, parents)) => Ok((open_relative_directory(root, parents)?, Some(*leaf))),
    }
}

fn stat_relative(root: &Dir, components: &[&str]) -> HelperResult<Metadata> {
    let (parent, leaf) = open_parent(root, components)?;
    match leaf {
        None => parent
            .dir_metadata()
            .map_err(|error| map_io_error(error, ErrorCode::OperationFailed)),
        Some(leaf) => parent
            .symlink_metadata(leaf)
            .map_err(|error| map_io_error(error, ErrorCode::OperationFailed)),
    }
}

fn metadata(value: &Metadata) -> HelperResult<WorkspaceMetadata> {
    let size = if value.is_file() {
        let length = value.len();
        if length > MAX_SAFE_INTEGER {
            return Err(HelperError::new(
                ErrorCode::OperationFailed,
                "Filesystem metadata exceeded the safe integer range.",
            ));
        }
        Some(length)
    } else {
        None
    };
    Ok(WorkspaceMetadata {
        kind: entry_kind(value),
        size,
        created_at_ms: value
            .created()
            .ok()
            .and_then(|time| system_time_ms(time.into_std())),
        modified_at_ms: value
            .modified()
            .ok()
            .and_then(|time| system_time_ms(time.into_std())),
    })
}

fn entry_kind(value: &Metadata) -> EntryKind {
    let file_type = value.file_type();
    if file_type.is_file() {
        EntryKind::File
    } else if file_type.is_dir() {
        EntryKind::Directory
    } else if file_type.is_symlink() {
        EntryKind::Symlink
    } else {
        EntryKind::Other
    }
}

fn system_time_ms(value: SystemTime) -> Option<i64> {
    let millis = match value.duration_since(UNIX_EPOCH) {
        Ok(duration) => i128::try_from(duration.as_millis()).ok()?,
        Err(error) => -i128::try_from(error.duration().as_millis()).ok()?,
    };
    if millis < -(i128::from(MAX_SAFE_INTEGER)) || millis > i128::from(MAX_SAFE_INTEGER) {
        None
    } else {
        i64::try_from(millis).ok()
    }
}

fn list_directory(directory: &Dir, limits: &ListLimits) -> HelperResult<ListResult> {
    if limits.max_depth == 0 {
        return Ok(ListResult {
            operation: "list",
            entries: Vec::new(),
            truncated: false,
        });
    }

    let mut pending = VecDeque::from([(Vec::<String>::new(), 0_usize)]);
    let mut directories_scanned = 0_usize;
    let mut entries = Vec::with_capacity(limits.max_entries.min(1_024));
    let mut truncated = false;

    while let Some((relative_directory, depth)) = pending.pop_front() {
        if directories_scanned == limits.max_directories {
            truncated = true;
            break;
        }
        directories_scanned += 1;
        let opened = open_owned_relative_directory(directory, &relative_directory)?;
        let iterator = opened
            .entries()
            .map_err(|error| map_io_error(error, ErrorCode::PathNotDirectory))?;
        let mut direct_entries = Vec::new();
        for entry in iterator {
            let entry = entry.map_err(|error| map_io_error(error, ErrorCode::OperationFailed))?;
            if entries.len() + direct_entries.len() == limits.max_entries {
                truncated = true;
                break;
            }
            let name = entry.file_name().into_string().map_err(|_| {
                HelperError::new(
                    ErrorCode::OperationFailed,
                    "Directory contains a non-UTF-8 entry name.",
                )
            })?;
            validate_entry_name(&name)?;
            let value = opened
                .symlink_metadata(&name)
                .map_err(|error| map_io_error(error, ErrorCode::OperationFailed))?;
            direct_entries.push((name, entry_kind(&value)));
        }
        direct_entries.sort_by(|left, right| left.0.cmp(&right.0));

        for (name, kind) in direct_entries {
            let mut components = relative_directory.clone();
            components.push(name);
            let path = components.join("/");
            let child_depth = depth + 1;
            if matches!(kind, EntryKind::Directory) && child_depth < limits.max_depth {
                if directories_scanned + pending.len() < limits.max_directories {
                    pending.push_back((components, child_depth));
                } else {
                    truncated = true;
                }
            }
            entries.push(ListEntry { path, kind });
        }

        if entries.len() == limits.max_entries {
            if !pending.is_empty() {
                truncated = true;
            }
            break;
        }
    }
    entries.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(ListResult {
        operation: "list",
        entries,
        truncated,
    })
}

fn validate_entry_name(name: &str) -> HelperResult<()> {
    if name.is_empty()
        || name == "."
        || name == ".."
        || name.contains('/')
        || name.contains('\\')
        || name.contains('\0')
        || name.len() > MAX_PATH_BYTES
    {
        return Err(HelperError::new(
            ErrorCode::OperationFailed,
            "Directory contains an invalid entry name.",
        ));
    }
    Ok(())
}

fn browse_directory(
    directory: &Dir,
    directory_path: String,
    max_entries: usize,
) -> HelperResult<BrowseResult> {
    let iterator = directory
        .entries()
        .map_err(|error| map_io_error(error, ErrorCode::PathNotDirectory))?;
    let mut entries = Vec::with_capacity(max_entries.min(1_024));
    let mut truncated = false;
    for entry in iterator {
        let entry = entry.map_err(|error| map_io_error(error, ErrorCode::OperationFailed))?;
        if entries.len() == max_entries {
            truncated = true;
            break;
        }
        let name = decode_browse_entry_name(entry.file_name())?;
        validate_browse_entry_name(&name)?;
        let value = directory
            .symlink_metadata(&name)
            .map_err(|error| map_io_error(error, ErrorCode::OperationFailed))?;
        entries.push(BrowseEntry {
            name,
            kind: entry_kind(&value),
        });
    }
    entries.sort_by(|left, right| left.name.cmp(&right.name));
    Ok(BrowseResult {
        operation: "browse",
        parent_path: browse_parent(&directory_path),
        directory_path,
        entries,
        truncated,
    })
}

fn decode_browse_entry_name(name: OsString) -> HelperResult<String> {
    name.into_string().map_err(|_| {
        HelperError::new(
            ErrorCode::OperationFailed,
            "Directory contains a non-UTF-8 entry name.",
        )
    })
}

fn validate_browse_entry_name(name: &str) -> HelperResult<()> {
    if name.is_empty()
        || name == "."
        || name == ".."
        || name.contains('/')
        || name.contains('\\')
        || name.contains('\0')
        || name.chars().count() > MAX_ENTRY_NAME_CHARS
    {
        return Err(HelperError::new(
            ErrorCode::OperationFailed,
            "Directory contains an invalid browse entry name.",
        ));
    }
    Ok(())
}

fn browse_parent(path: &str) -> Option<String> {
    if path == "/" {
        return None;
    }
    let separator = path.rfind('/').expect("normalized absolute path");
    if separator == 0 {
        Some("/".to_owned())
    } else {
        Some(path[..separator].to_owned())
    }
}

fn fit_browse_response(value: Value, max_bytes: usize) -> HelperResult<Value> {
    if ascii_json(&value)?.len() <= max_bytes {
        return Ok(value);
    }
    let result = value
        .get("result")
        .and_then(Value::as_object)
        .ok_or_else(internal_error)?;
    let directory_path = result
        .get("directoryPath")
        .and_then(Value::as_str)
        .ok_or_else(internal_error)?;
    let parent_path = result
        .get("parentPath")
        .cloned()
        .ok_or_else(internal_error)?;
    let entries = result
        .get("entries")
        .and_then(Value::as_array)
        .ok_or_else(internal_error)?;
    let already_truncated = result
        .get("truncated")
        .and_then(Value::as_bool)
        .ok_or_else(internal_error)?;
    let mut low = 0;
    let mut high = if already_truncated {
        entries.len()
    } else {
        entries.len().saturating_sub(1)
    };
    while low < high {
        let middle = (low + high).div_ceil(2);
        let candidate = browse_value(
            directory_path,
            parent_path.clone(),
            entries[..middle].to_vec(),
            true,
        );
        if ascii_json(&candidate)?.len() <= max_bytes {
            low = middle;
        } else {
            high = middle - 1;
        }
    }
    let candidate = browse_value(directory_path, parent_path, entries[..low].to_vec(), true);
    if ascii_json(&candidate)?.len() > max_bytes {
        return Err(HelperError::new(
            ErrorCode::LimitExceeded,
            "Browse response byte limit is too small.",
        ));
    }
    Ok(candidate)
}

fn browse_value(
    directory_path: &str,
    parent_path: Value,
    entries: Vec<Value>,
    truncated: bool,
) -> Value {
    serde_json::json!({
        "protocol": PROTOCOL,
        "ok": true,
        "result": {
            "operation": "browse",
            "directoryPath": directory_path,
            "parentPath": parent_path,
            "entries": entries,
            "truncated": truncated,
        }
    })
}

fn fit_list_response(value: Value, max_bytes: usize) -> HelperResult<Value> {
    if ascii_json(&value)?.len() <= max_bytes {
        return Ok(value);
    }
    let result = value
        .get("result")
        .and_then(Value::as_object)
        .ok_or_else(internal_error)?;
    let entries = result
        .get("entries")
        .and_then(Value::as_array)
        .ok_or_else(internal_error)?;
    let mut low = 0;
    let mut high = entries.len();
    while low < high {
        let middle = (low + high).div_ceil(2);
        let candidate = list_value(entries[..middle].to_vec(), true);
        if ascii_json(&candidate)?.len() <= max_bytes {
            low = middle;
        } else {
            high = middle - 1;
        }
    }
    let candidate = list_value(entries[..low].to_vec(), true);
    if ascii_json(&candidate)?.len() > max_bytes {
        return Err(HelperError::new(
            ErrorCode::LimitExceeded,
            "Directory response byte limit is too small.",
        ));
    }
    Ok(candidate)
}

fn list_value(entries: Vec<Value>, truncated: bool) -> Value {
    serde_json::json!({
        "protocol": PROTOCOL,
        "ok": true,
        "result": {
            "operation": "list",
            "entries": entries,
            "truncated": truncated,
        }
    })
}

fn read_file(root: &Dir, components: &[&str], max_bytes: usize) -> HelperResult<ReadResult> {
    let (parent, leaf) = open_parent(root, components)?;
    let leaf = leaf
        .ok_or_else(|| HelperError::new(ErrorCode::PathNotFile, "Workspace root is not a file."))?;
    let mut file = open_nofollow(&parent, leaf, false)?;
    let value = file
        .metadata()
        .map_err(|error| map_io_error(error, ErrorCode::OperationFailed))?;
    let mut observed = Vec::with_capacity(max_bytes.saturating_add(1));
    file.by_ref()
        .take(u64::try_from(max_bytes).unwrap_or(u64::MAX) + 1)
        .read_to_end(&mut observed)
        .map_err(|_| {
            HelperError::new(
                ErrorCode::OperationFailed,
                "Workspace file could not be read.",
            )
        })?;
    let byte_length = value
        .len()
        .max(u64::try_from(observed.len()).unwrap_or(u64::MAX));
    if byte_length > MAX_SAFE_INTEGER {
        return Err(HelperError::new(
            ErrorCode::OperationFailed,
            "Filesystem metadata exceeded the safe integer range.",
        ));
    }
    let truncated =
        byte_length > u64::try_from(max_bytes).unwrap_or(u64::MAX) || observed.len() > max_bytes;
    observed.truncate(max_bytes);
    Ok(ReadResult {
        operation: "read",
        data_base64: BASE64.encode(observed),
        byte_length,
        truncated,
    })
}

fn success_value<T: Serialize>(result: T, response_limit: usize) -> HelperResult<(Value, usize)> {
    Ok((success_json(result)?, response_limit))
}

fn success_json<T: Serialize>(result: T) -> HelperResult<Value> {
    serde_json::to_value(SuccessResponse {
        protocol: PROTOCOL,
        ok: true,
        result,
    })
    .map_err(|_| internal_error())
}

fn frame_with_limit(response: Value, response_limit: usize) -> Vec<u8> {
    match ascii_json(&response) {
        Ok(payload) if payload.len() <= response_limit && payload.len() <= MAX_RESPONSE_BYTES => {
            frame_payload(payload)
        }
        _ => frame_error(HelperError::new(
            ErrorCode::LimitExceeded,
            "Helper response exceeded its byte limit.",
        )),
    }
}

fn frame_error(error: HelperError) -> Vec<u8> {
    let response = ErrorResponse {
        protocol: PROTOCOL,
        ok: false,
        error: ErrorBody {
            code: error.code,
            message: error.message,
        },
    };
    let value = serde_json::to_value(response).unwrap_or_else(|_| {
        serde_json::json!({
            "protocol": PROTOCOL,
            "ok": false,
            "error": {"code": "operation_failed", "message": "Workspace helper operation failed."}
        })
    });
    let payload = ascii_json(&value).unwrap_or_else(|_| {
        br#"{"protocol":1,"ok":false,"error":{"code":"operation_failed","message":"Workspace helper operation failed."}}"#.to_vec()
    });
    frame_payload(payload)
}

fn ascii_json(value: &Value) -> HelperResult<Vec<u8>> {
    let json = serde_json::to_string(value).map_err(|_| internal_error())?;
    let mut ascii = String::with_capacity(json.len());
    for character in json.chars() {
        if character.is_ascii() {
            ascii.push(character);
        } else {
            for unit in character.encode_utf16(&mut [0; 2]) {
                use std::fmt::Write as _;
                write!(&mut ascii, "\\u{unit:04x}").map_err(|_| internal_error())?;
            }
        }
    }
    Ok(ascii.into_bytes())
}

fn frame_payload(payload: Vec<u8>) -> Vec<u8> {
    let digest = Sha256::digest(&payload);
    let header = format!("CWH1 {} {digest:x}\n", payload.len());
    let mut frame = Vec::with_capacity(header.len() + payload.len());
    frame.extend_from_slice(header.as_bytes());
    frame.extend_from_slice(&payload);
    frame
}

fn map_io_error(error: io::Error, fallback: ErrorCode) -> HelperError {
    match error.kind() {
        io::ErrorKind::NotFound => HelperError::new(ErrorCode::PathNotFound, "Path was not found."),
        io::ErrorKind::NotADirectory => {
            HelperError::new(ErrorCode::PathNotDirectory, "Path is not a directory.")
        }
        _ => HelperError::new(fallback, "Provider-host filesystem operation failed."),
    }
}

fn internal_error() -> HelperError {
    HelperError::new(
        ErrorCode::OperationFailed,
        "Workspace helper operation failed.",
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::ffi::OsStringExt;

    #[test]
    fn relative_paths_are_strict_descendants() {
        for invalid in ["/absolute", ".", "..", "a/../b", "a//b", "a\\b", "a\0b"] {
            assert!(split_relative(invalid).is_err(), "accepted {invalid:?}");
        }
        assert_eq!(split_relative("").unwrap(), Vec::<&str>::new());
        assert_eq!(split_relative("a/b").unwrap(), vec!["a", "b"]);
    }

    #[test]
    fn frame_is_ascii_length_delimited_and_digested() {
        let frame = frame_payload(br#"{"value":"ok"}"#.to_vec());
        let newline = frame.iter().position(|byte| *byte == b'\n').unwrap();
        let header = std::str::from_utf8(&frame[..newline]).unwrap();
        let fields: Vec<_> = header.split(' ').collect();
        assert_eq!(fields[0], "CWH1");
        assert_eq!(
            fields[1].parse::<usize>().unwrap(),
            frame.len() - newline - 1
        );
        assert_eq!(
            fields[2],
            format!("{:x}", Sha256::digest(&frame[newline + 1..]))
        );
        assert!(frame.is_ascii());
    }

    #[test]
    fn browse_entry_names_reject_non_utf8_bytes() {
        let invalid = OsString::from_vec(vec![b'b', b'a', b'd', 0xff]);
        let error = decode_browse_entry_name(invalid).unwrap_err();
        assert!(matches!(error.code, ErrorCode::OperationFailed));
    }
}
