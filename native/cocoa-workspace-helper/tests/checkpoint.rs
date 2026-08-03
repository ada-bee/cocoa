use std::ffi::OsString;
use std::fs;
use std::os::unix::fs::symlink;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use fs2::FileExt as _;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tempfile::TempDir;

const PROTOCOL: &str = "cocoa.checkpoint.v1";
const OP1: &str = "10000000-0000-4000-8000-000000000001";
const OP2: &str = "10000000-0000-4000-8000-000000000002";
const OP3: &str = "10000000-0000-4000-8000-000000000003";
const CHECKPOINT1: &str = "20000000-0000-4000-8000-000000000001";
const CHECKPOINT2: &str = "20000000-0000-4000-8000-000000000002";

fn git_executable() -> PathBuf {
    let output = Command::new("sh")
        .args(["-c", "command -v git"])
        .output()
        .unwrap();
    assert!(output.status.success());
    let value = String::from_utf8(output.stdout).unwrap();
    fs::canonicalize(value.trim()).unwrap()
}

fn git(git: &Path, repository: &Path, args: &[&str]) -> String {
    let output = Command::new(git)
        .arg("-C")
        .arg(repository)
        .args(args)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "git {:?}: {}",
        args,
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout)
        .unwrap()
        .trim_end()
        .to_owned()
}

fn repository() -> (TempDir, PathBuf, PathBuf) {
    let temp = TempDir::new().unwrap();
    let root = temp.path().join("repository");
    fs::create_dir(&root).unwrap();
    let git_path = git_executable();
    git(&git_path, &root, &["init", "--quiet"]);
    git(&git_path, &root, &["config", "user.name", "Cocoa Test"]);
    git(
        &git_path,
        &root,
        &["config", "user.email", "cocoa@example.invalid"],
    );
    fs::write(root.join("tracked.txt"), "initial\n").unwrap();
    fs::write(root.join(".gitignore"), "ignored.txt\n").unwrap();
    git(&git_path, &root, &["add", "."]);
    git(&git_path, &root, &["commit", "--quiet", "-m", "initial"]);
    (temp, root, git_path)
}

fn invoke(request: Value) -> (Value, Vec<u8>) {
    let bytes = serde_json::to_vec(&request).unwrap();
    let frame = cocoa_workspace_helper::run_argv(vec![OsString::from(BASE64.encode(&bytes))]);
    let newline = frame.iter().position(|byte| *byte == b'\n').unwrap();
    let header = std::str::from_utf8(&frame[..newline]).unwrap();
    let fields: Vec<_> = header.split(' ').collect();
    assert_eq!(fields[0], "CCH1");
    let payload = &frame[newline + 1..];
    assert_eq!(fields[1].parse::<usize>().unwrap(), payload.len());
    assert_eq!(fields[2], format!("{:x}", Sha256::digest(payload)));
    assert!(frame.is_ascii());
    (serde_json::from_slice(payload).unwrap(), bytes)
}

fn open(root: &Path, git_path: &Path) -> Value {
    let (response, _) = invoke(json!({
        "protocol": PROTOCOL,
        "operation": "open",
        "gitExecutablePath": git_path.to_str().unwrap(),
        "workspaceRoot": root.to_str().unwrap(),
    }));
    assert_eq!(response["ok"], true, "{response:#}");
    assert!(response["result"].get("headOid").is_some());
    assert!(response["result"].get("head_oid").is_none());
    response["result"]["binding"].clone()
}

fn capture(
    root: &Path,
    git_path: &Path,
    binding: &Value,
    operation_id: &str,
    checkpoint_id: &str,
) -> (Value, Vec<u8>) {
    let _ = root;
    invoke(json!({
        "protocol": PROTOCOL,
        "operation": "capture",
        "gitExecutablePath": git_path.to_str().unwrap(),
        "expectedBinding": binding,
        "operationId": operation_id,
        "checkpointId": checkpoint_id,
    }))
}

#[test]
fn checkpoint_probe_and_open_use_cch1_without_changing_workspace_v1() {
    let (_temp, root, git_path) = repository();
    let (probe, _) = invoke(json!({
        "protocol": PROTOCOL,
        "operation": "probe",
        "gitExecutablePath": git_path.to_str().unwrap(),
    }));
    assert_eq!(probe["ok"], true);
    assert_eq!(probe["result"]["limits"]["maxRequestBytes"], 65_536);
    assert_eq!(
        probe["result"]["limits"]["maxResponseBytes"],
        6 * 1024 * 1024
    );
    assert_eq!(probe["result"]["capabilities"].as_array().unwrap().len(), 7);

    let binding = open(&root, &git_path);
    assert_eq!(
        binding["worktreeRoot"]["canonicalPath"],
        root.to_str().unwrap()
    );
    assert_eq!(binding["objectFormat"], "sha1");
    assert_eq!(binding["fingerprint"].as_str().unwrap().len(), 64);
    let mut fingerprint = Sha256::new();
    for value in [
        PROTOCOL,
        binding["worktreeRoot"]["canonicalPath"].as_str().unwrap(),
        binding["worktreeRoot"]["device"].as_str().unwrap(),
        binding["worktreeRoot"]["inode"].as_str().unwrap(),
        binding["gitDirectoryRoot"]["canonicalPath"]
            .as_str()
            .unwrap(),
        binding["gitDirectoryRoot"]["device"].as_str().unwrap(),
        binding["gitDirectoryRoot"]["inode"].as_str().unwrap(),
        binding["gitCommonDirectoryRoot"]["canonicalPath"]
            .as_str()
            .unwrap(),
        binding["gitCommonDirectoryRoot"]["device"]
            .as_str()
            .unwrap(),
        binding["gitCommonDirectoryRoot"]["inode"].as_str().unwrap(),
        binding["objectFormat"].as_str().unwrap(),
    ] {
        fingerprint.update(value.as_bytes());
        fingerprint.update([0]);
    }
    assert_eq!(
        binding["fingerprint"],
        format!("{:x}", fingerprint.finalize())
    );

    let encoded = BASE64.encode(br#"{"protocol":1,"operation":"probe"}"#);
    let frame = cocoa_workspace_helper::run_argv(vec![OsString::from(encoded)]);
    assert!(frame.starts_with(b"CWH1 "));
}

#[test]
fn capture_diff_restore_observe_and_atomic_delete_round_trip() {
    let (_temp, root, git_path) = repository();
    let binding = open(&root, &git_path);
    fs::write(root.join("tracked.txt"), "checkpoint one\n").unwrap();
    fs::write(root.join("untracked.txt"), "present in one\n").unwrap();
    fs::write(root.join("ignored.txt"), "ignored survives restore\n").unwrap();

    let (first, first_request) = capture(&root, &git_path, &binding, OP1, CHECKPOINT1);
    assert_eq!(first["ok"], true, "{first:#}");
    assert!(first["result"].get("receiptObjectOid").is_some());
    assert!(first["result"].get("receiptObjectId").is_none());
    let first_receipt = &first["result"]["receipt"];
    assert_eq!(
        first_receipt["checkpointRef"],
        format!("refs/cocoa/checkpoints/v1/{CHECKPOINT1}")
    );
    assert_eq!(
        first_receipt["receiptRef"],
        format!("refs/cocoa/checkpoint-receipts/v1/{OP1}")
    );
    assert_eq!(
        first_receipt["requestSha256"],
        format!("{:x}", Sha256::digest(&first_request))
    );
    assert_ne!(first_receipt["checkpointOid"], first_receipt["treeOid"]);

    fs::write(
        root.join("tracked.txt"),
        "checkpoint two with a longer payload\n",
    )
    .unwrap();
    fs::remove_file(root.join("untracked.txt")).unwrap();
    fs::write(root.join("second.txt"), "only in two\n").unwrap();
    let (second, _) = capture(&root, &git_path, &binding, OP2, CHECKPOINT2);
    assert_eq!(second["ok"], true, "{second:#}");

    let (diff, _) = invoke(json!({
        "protocol": PROTOCOL,
        "operation": "diff",
        "gitExecutablePath": git_path.to_str().unwrap(),
        "expectedBinding": binding,
        "baseCheckpointId": CHECKPOINT1,
        "targetCheckpointId": CHECKPOINT2,
        "ignoreWhitespace": false,
        "limits": {"maxPatchBytes": 32},
    }));
    assert_eq!(diff["ok"], true, "{diff:#}");
    assert_eq!(diff["result"]["truncated"], true);
    assert_eq!(
        BASE64
            .decode(diff["result"]["patchBase64"].as_str().unwrap())
            .unwrap()
            .len(),
        32
    );
    assert_eq!(diff["result"]["byteLength"], 32);

    fs::write(root.join("tracked.txt"), "after both\n").unwrap();
    fs::write(root.join("junk.txt"), "remove me\n").unwrap();
    let checkpoint_oid = first_receipt["checkpointOid"].as_str().unwrap();
    let (restored, restore_request) = invoke(json!({
        "protocol": PROTOCOL,
        "operation": "restore",
        "gitExecutablePath": git_path.to_str().unwrap(),
        "expectedBinding": binding,
        "operationId": OP3,
        "checkpointId": CHECKPOINT1,
        "expectedCheckpointOid": checkpoint_oid,
    }));
    assert_eq!(restored["ok"], true, "{restored:#}");
    assert!(restored["result"].get("receiptObjectOid").is_some());
    assert_eq!(
        fs::read_to_string(root.join("tracked.txt")).unwrap(),
        "checkpoint one\n"
    );
    assert_eq!(
        fs::read_to_string(root.join("untracked.txt")).unwrap(),
        "present in one\n"
    );
    assert!(!root.join("junk.txt").exists());
    assert_eq!(
        fs::read_to_string(root.join("ignored.txt")).unwrap(),
        "ignored survives restore\n"
    );

    let restore_digest = format!("{:x}", Sha256::digest(&restore_request));
    let (observed, _) = invoke(json!({
        "protocol": PROTOCOL,
        "operation": "observe",
        "gitExecutablePath": git_path.to_str().unwrap(),
        "expectedBinding": binding,
        "operationId": OP3,
        "expectedRequestSha256": restore_digest,
    }));
    assert_eq!(observed["result"]["status"], "found");
    assert_eq!(observed["result"]["receipt"], restored["result"]["receipt"]);
    assert!(observed["result"]["receipt"]
        .get("receiptObjectOid")
        .is_none());

    let (deleted, _) = invoke(json!({
        "protocol": PROTOCOL,
        "operation": "delete",
        "gitExecutablePath": git_path.to_str().unwrap(),
        "expectedBinding": binding,
        "operationId": "10000000-0000-4000-8000-000000000004",
        "checkpoints": [
            {"checkpointId": CHECKPOINT1, "expectedCheckpointOid": checkpoint_oid},
            {"checkpointId": "20000000-0000-4000-8000-000000000003", "expectedCheckpointOid": checkpoint_oid}
        ],
    }));
    assert_eq!(deleted["ok"], true, "{deleted:#}");
    assert!(deleted["result"].get("receiptObjectOid").is_some());
    assert_eq!(
        deleted["result"]["receipt"]["checkpoints"][0]["status"],
        "deleted"
    );
    assert_eq!(
        deleted["result"]["receipt"]["checkpoints"][1]["status"],
        "already_absent"
    );
    let missing = Command::new(&git_path)
        .arg("-C")
        .arg(&root)
        .args([
            "show-ref",
            "--verify",
            &format!("refs/cocoa/checkpoints/v1/{CHECKPOINT1}"),
        ])
        .output()
        .unwrap();
    assert!(!missing.status.success());
}

#[test]
fn strict_ids_cas_binding_and_symlink_checks_fail_closed_without_path_echoes() {
    let (temp, root, git_path) = repository();
    let binding = open(&root, &git_path);
    for hostile in [
        "--help",
        "00000000-0000-0000-0000-000000000000",
        "20000000-0000-4000-7000-000000000001",
        "20000000-0000-9000-8000-000000000001",
        "20000000-0000-4000-8000-00000000000A",
    ] {
        let (response, _) = capture(&root, &git_path, &binding, OP1, hostile);
        assert_eq!(
            response["error"]["code"], "invalid_request",
            "{hostile}: {response:#}"
        );
    }

    let mut drifted = binding.clone();
    drifted["worktreeRoot"]["inode"] = json!("1");
    let (response, _) = capture(&root, &git_path, &drifted, OP1, CHECKPOINT1);
    assert_eq!(response["error"]["code"], "binding_changed");

    let alias = temp.path().join("alias");
    symlink(&root, &alias).unwrap();
    let (response, _) = invoke(json!({
        "protocol": PROTOCOL,
        "operation": "open",
        "gitExecutablePath": git_path.to_str().unwrap(),
        "workspaceRoot": alias.to_str().unwrap(),
    }));
    assert_eq!(response["error"]["code"], "not_a_repository");
    assert!(!response.to_string().contains(alias.to_str().unwrap()));

    let git_alias = temp.path().join("git-alias");
    symlink(&git_path, &git_alias).unwrap();
    let (response, _) = invoke(json!({
        "protocol": PROTOCOL,
        "operation": "probe",
        "gitExecutablePath": git_alias.to_str().unwrap(),
    }));
    assert_eq!(response["error"]["code"], "invalid_git_executable");

    let (captured, _) = capture(&root, &git_path, &binding, OP1, CHECKPOINT1);
    assert_eq!(captured["ok"], true, "{captured:#}");
    let oid = captured["result"]["receipt"]["checkpointOid"]
        .as_str()
        .unwrap();
    let wrong_oid = if let Some(rest) = oid.strip_prefix('0') {
        format!("1{rest}")
    } else {
        format!("0{}", &oid[1..])
    };
    let (mismatch, _) = invoke(json!({
        "protocol": PROTOCOL,
        "operation": "restore",
        "gitExecutablePath": git_path.to_str().unwrap(),
        "expectedBinding": binding,
        "operationId": OP2,
        "checkpointId": CHECKPOINT1,
        "expectedCheckpointOid": wrong_oid,
    }));
    assert_eq!(mismatch["error"]["code"], "checkpoint_oid_mismatch");

    let (conflict, _) = capture(&root, &git_path, &binding, OP1, CHECKPOINT2);
    assert_eq!(conflict["error"]["code"], "operation_id_conflict");

    let (exists, _) = capture(
        &root,
        &git_path,
        &binding,
        "10000000-0000-4000-8000-000000000010",
        CHECKPOINT1,
    );
    assert_eq!(exists["error"]["code"], "checkpoint_exists");

    let (digest_conflict, _) = invoke(json!({
        "protocol": PROTOCOL,
        "operation": "observe",
        "gitExecutablePath": git_path.to_str().unwrap(),
        "expectedBinding": binding,
        "operationId": OP1,
        "expectedRequestSha256": "0".repeat(64),
    }));
    assert_eq!(digest_conflict["error"]["code"], "operation_id_conflict");

    let (duplicates, _) = invoke(json!({
        "protocol": PROTOCOL,
        "operation": "delete",
        "gitExecutablePath": git_path.to_str().unwrap(),
        "expectedBinding": binding,
        "operationId": "10000000-0000-4000-8000-000000000011",
        "checkpoints": [
            {"checkpointId": CHECKPOINT1, "expectedCheckpointOid": oid},
            {"checkpointId": CHECKPOINT1, "expectedCheckpointOid": oid}
        ],
    }));
    assert_eq!(duplicates["error"]["code"], "invalid_request");

    let missing_digest = "0".repeat(64);
    let (missing, _) = invoke(json!({
        "protocol": PROTOCOL,
        "operation": "observe",
        "gitExecutablePath": git_path.to_str().unwrap(),
        "expectedBinding": binding,
        "operationId": "10000000-0000-4000-8000-000000000099",
        "expectedRequestSha256": missing_digest,
    }));
    assert_eq!(missing["ok"], true);
    assert_eq!(
        missing["result"],
        json!({"operation": "observe", "status": "not_found"})
    );
}

#[test]
fn locked_repository_fails_fast_with_retryable_busy() {
    let (_temp, root, git_path) = repository();
    let binding = open(&root, &git_path);
    let common = binding["gitCommonDirectoryRoot"]["canonicalPath"]
        .as_str()
        .unwrap();
    let lock = fs::OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .truncate(false)
        .open(Path::new(common).join("cocoa-checkpoint-v1.lock"))
        .unwrap();
    lock.lock_exclusive().unwrap();
    let (response, _) = capture(&root, &git_path, &binding, OP1, CHECKPOINT1);
    assert_eq!(response["error"]["code"], "repository_busy");
    assert_eq!(response["error"]["retryable"], true);
}

#[test]
fn external_content_filters_are_rejected_without_execution() {
    let (temp, root, git_path) = repository();
    let binding = open(&root, &git_path);
    let (captured, _) = capture(&root, &git_path, &binding, OP1, CHECKPOINT1);
    assert_eq!(captured["ok"], true, "{captured:#}");
    let checkpoint_oid = captured["result"]["receipt"]["checkpointOid"]
        .as_str()
        .unwrap();

    let marker = temp.path().join("filter-executed");
    let command = format!("sh -c 'touch {}; cat'", marker.display());
    let included_config = temp.path().join("included-filter.config");
    fs::write(
        &included_config,
        format!("[filter \"hostile\"]\n\tclean = {command}\n"),
    )
    .unwrap();
    git(
        &git_path,
        &root,
        &["config", "include.path", included_config.to_str().unwrap()],
    );
    git(
        &git_path,
        &root,
        &["config", "filter.hostile.smudge", &command],
    );
    git(
        &git_path,
        &root,
        &["config", "extensions.worktreeConfig", "true"],
    );
    git(
        &git_path,
        &root,
        &["config", "--worktree", "filter.hostile.process", &command],
    );
    fs::write(root.join(".gitattributes"), "*.txt filter=hostile\n").unwrap();
    fs::write(root.join("tracked.txt"), "would invoke clean\n").unwrap();

    let (capture_rejected, _) = capture(&root, &git_path, &binding, OP2, CHECKPOINT2);
    assert_eq!(capture_rejected["error"]["code"], "operation_failed");
    assert!(!marker.exists());

    let (restore_rejected, _) = invoke(json!({
        "protocol": PROTOCOL,
        "operation": "restore",
        "gitExecutablePath": git_path.to_str().unwrap(),
        "expectedBinding": binding,
        "operationId": OP3,
        "checkpointId": CHECKPOINT1,
        "expectedCheckpointOid": checkpoint_oid,
    }));
    assert_eq!(restore_rejected["error"]["code"], "operation_failed");
    assert!(!marker.exists());
}

fn tree_summary(path: &Path) -> (usize, u64) {
    let mut pending = vec![path.to_path_buf()];
    let mut files = 0_usize;
    let mut bytes = 0_u64;
    while let Some(directory) = pending.pop() {
        for entry in fs::read_dir(directory).unwrap() {
            let entry = entry.unwrap();
            let metadata = entry.metadata().unwrap();
            if metadata.is_dir() {
                pending.push(entry.path());
            } else {
                files += 1;
                bytes = bytes.saturating_add(metadata.len());
            }
        }
    }
    (files, bytes)
}

#[test]
fn symlinked_git_writable_metadata_never_writes_outside_binding() {
    {
        let (temp, root, git_path) = repository();
        let binding = open(&root, &git_path);
        let common = PathBuf::from(
            binding["gitCommonDirectoryRoot"]["canonicalPath"]
                .as_str()
                .unwrap(),
        );
        let outside = temp.path().join("outside-objects");
        fs::rename(common.join("objects"), &outside).unwrap();
        symlink(&outside, common.join("objects")).unwrap();
        let before = tree_summary(&outside);
        let (response, _) = capture(&root, &git_path, &binding, OP1, CHECKPOINT1);
        assert_eq!(response["error"]["code"], "operation_failed");
        assert_eq!(tree_summary(&outside), before);
    }

    {
        let (temp, root, git_path) = repository();
        let binding = open(&root, &git_path);
        let common = PathBuf::from(
            binding["gitCommonDirectoryRoot"]["canonicalPath"]
                .as_str()
                .unwrap(),
        );
        let outside = temp.path().join("outside-refs");
        fs::create_dir(&outside).unwrap();
        symlink(&outside, common.join("refs/cocoa")).unwrap();
        let (response, _) = capture(&root, &git_path, &binding, OP1, CHECKPOINT1);
        assert_eq!(response["error"]["code"], "operation_failed");
        assert_eq!(tree_summary(&outside), (0, 0));
    }

    {
        let (temp, root, git_path) = repository();
        let binding = open(&root, &git_path);
        let (captured, _) = capture(&root, &git_path, &binding, OP1, CHECKPOINT1);
        assert_eq!(captured["ok"], true, "{captured:#}");
        let checkpoint_oid = captured["result"]["receipt"]["checkpointOid"]
            .as_str()
            .unwrap();
        let git_directory = PathBuf::from(
            binding["gitDirectoryRoot"]["canonicalPath"]
                .as_str()
                .unwrap(),
        );
        let outside_index = temp.path().join("outside-index");
        fs::rename(git_directory.join("index"), &outside_index).unwrap();
        symlink(&outside_index, git_directory.join("index")).unwrap();
        let before = fs::read(&outside_index).unwrap();
        fs::write(root.join("tracked.txt"), "must not restore\n").unwrap();
        let (response, _) = invoke(json!({
            "protocol": PROTOCOL,
            "operation": "restore",
            "gitExecutablePath": git_path.to_str().unwrap(),
            "expectedBinding": binding,
            "operationId": OP2,
            "checkpointId": CHECKPOINT1,
            "expectedCheckpointOid": checkpoint_oid,
        }));
        assert_eq!(response["error"]["code"], "operation_failed");
        assert_eq!(fs::read(outside_index).unwrap(), before);
        assert_eq!(
            fs::read_to_string(root.join("tracked.txt")).unwrap(),
            "must not restore\n"
        );
    }
}

#[test]
fn receipt_and_checkpoint_refs_cannot_redirect_authority() {
    let (temp, root, git_path) = repository();
    let binding = open(&root, &git_path);
    let (first, first_request) = capture(&root, &git_path, &binding, OP1, CHECKPOINT1);
    assert_eq!(first["ok"], true, "{first:#}");
    fs::write(root.join("tracked.txt"), "second\n").unwrap();
    let (second, _) = capture(&root, &git_path, &binding, OP2, CHECKPOINT2);
    assert_eq!(second["ok"], true, "{second:#}");

    let common = PathBuf::from(
        binding["gitCommonDirectoryRoot"]["canonicalPath"]
            .as_str()
            .unwrap(),
    );
    let receipt = common.join(format!("refs/cocoa/checkpoint-receipts/v1/{OP1}"));
    let outside_receipt = temp.path().join("outside-receipt");
    fs::rename(&receipt, &outside_receipt).unwrap();
    symlink(&outside_receipt, &receipt).unwrap();
    let digest = format!("{:x}", Sha256::digest(&first_request));
    let (observed, _) = invoke(json!({
        "protocol": PROTOCOL,
        "operation": "observe",
        "gitExecutablePath": git_path.to_str().unwrap(),
        "expectedBinding": binding,
        "operationId": OP1,
        "expectedRequestSha256": digest,
    }));
    assert_eq!(observed["error"]["code"], "operation_failed");
    let (replayed, _) = capture(&root, &git_path, &binding, OP1, CHECKPOINT1);
    assert_eq!(replayed["error"]["code"], "operation_failed");

    let checkpoint = common.join(format!("refs/cocoa/checkpoints/v1/{CHECKPOINT1}"));
    let original_checkpoint = fs::read(&checkpoint).unwrap();
    fs::remove_file(&checkpoint).unwrap();
    fs::write(&checkpoint, "ref: refs/heads/master\n").unwrap();
    let diff_request = || {
        json!({
            "protocol": PROTOCOL,
            "operation": "diff",
            "gitExecutablePath": git_path.to_str().unwrap(),
            "expectedBinding": binding,
            "baseCheckpointId": CHECKPOINT1,
            "targetCheckpointId": CHECKPOINT2,
            "ignoreWhitespace": false,
            "limits": {"maxPatchBytes": 4096},
        })
    };
    let (symbolic, _) = invoke(diff_request());
    assert_eq!(symbolic["error"]["code"], "operation_failed");

    fs::remove_file(&checkpoint).unwrap();
    let outside_checkpoint = temp.path().join("outside-checkpoint");
    fs::write(&outside_checkpoint, original_checkpoint).unwrap();
    symlink(&outside_checkpoint, &checkpoint).unwrap();
    let (symlinked, _) = invoke(diff_request());
    assert_eq!(symlinked["error"]["code"], "operation_failed");
}

fn marker_script(path: &Path, marker: &Path) {
    fs::write(
        path,
        format!("#!/bin/sh\ntouch '{}'\nexit 0\n", marker.display()),
    )
    .unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
}

#[test]
fn hooks_fsmonitor_external_diff_and_textconv_never_execute() {
    let (temp, root, git_path) = repository();
    let binding = open(&root, &git_path);
    let git_directory = PathBuf::from(
        binding["gitDirectoryRoot"]["canonicalPath"]
            .as_str()
            .unwrap(),
    );

    let hook_marker = temp.path().join("hook-marker");
    marker_script(
        &git_directory.join("hooks/reference-transaction"),
        &hook_marker,
    );
    let fsmonitor_marker = temp.path().join("fsmonitor-marker");
    let fsmonitor = temp.path().join("fsmonitor.sh");
    marker_script(&fsmonitor, &fsmonitor_marker);
    git(
        &git_path,
        &root,
        &["config", "core.fsmonitor", fsmonitor.to_str().unwrap()],
    );
    let external_diff_marker = temp.path().join("external-diff-marker");
    let external_diff = temp.path().join("external-diff.sh");
    marker_script(&external_diff, &external_diff_marker);
    git(
        &git_path,
        &root,
        &["config", "diff.external", external_diff.to_str().unwrap()],
    );
    let textconv_marker = temp.path().join("textconv-marker");
    let textconv = temp.path().join("textconv.sh");
    marker_script(&textconv, &textconv_marker);
    git(
        &git_path,
        &root,
        &[
            "config",
            "diff.hostile.textconv",
            textconv.to_str().unwrap(),
        ],
    );
    fs::write(root.join(".gitattributes"), "*.txt diff=hostile\n").unwrap();

    let (first, _) = capture(&root, &git_path, &binding, OP1, CHECKPOINT1);
    assert_eq!(first["ok"], true, "{first:#}");
    for marker in [
        &hook_marker,
        &fsmonitor_marker,
        &external_diff_marker,
        &textconv_marker,
    ] {
        assert!(!marker.exists(), "unexpected marker: {}", marker.display());
    }
    fs::write(root.join("tracked.txt"), "second state\n").unwrap();
    let (second, _) = capture(&root, &git_path, &binding, OP2, CHECKPOINT2);
    assert_eq!(second["ok"], true, "{second:#}");

    let (diff, _) = invoke(json!({
        "protocol": PROTOCOL,
        "operation": "diff",
        "gitExecutablePath": git_path.to_str().unwrap(),
        "expectedBinding": binding,
        "baseCheckpointId": CHECKPOINT1,
        "targetCheckpointId": CHECKPOINT2,
        "ignoreWhitespace": false,
        "limits": {"maxPatchBytes": 4096},
    }));
    assert_eq!(diff["ok"], true, "{diff:#}");

    let first_oid = first["result"]["receipt"]["checkpointOid"]
        .as_str()
        .unwrap();
    let second_oid = second["result"]["receipt"]["checkpointOid"]
        .as_str()
        .unwrap();
    let (restored, _) = invoke(json!({
        "protocol": PROTOCOL,
        "operation": "restore",
        "gitExecutablePath": git_path.to_str().unwrap(),
        "expectedBinding": binding,
        "operationId": OP3,
        "checkpointId": CHECKPOINT1,
        "expectedCheckpointOid": first_oid,
    }));
    assert_eq!(restored["ok"], true, "{restored:#}");

    let (deleted, _) = invoke(json!({
        "protocol": PROTOCOL,
        "operation": "delete",
        "gitExecutablePath": git_path.to_str().unwrap(),
        "expectedBinding": binding,
        "operationId": "10000000-0000-4000-8000-000000000004",
        "checkpoints": [
            {"checkpointId": CHECKPOINT1, "expectedCheckpointOid": first_oid},
            {"checkpointId": CHECKPOINT2, "expectedCheckpointOid": second_oid}
        ],
    }));
    assert_eq!(deleted["ok"], true, "{deleted:#}");
    for marker in [
        &hook_marker,
        &fsmonitor_marker,
        &external_diff_marker,
        &textconv_marker,
    ] {
        assert!(!marker.exists(), "unexpected marker: {}", marker.display());
    }
}

#[test]
fn checkpoint_requests_are_strict_and_bounded() {
    let (_temp, _root, git_path) = repository();
    let (strict, _) = invoke(json!({
        "protocol": PROTOCOL,
        "operation": "probe",
        "gitExecutablePath": git_path.to_str().unwrap(),
        "unexpected": true,
    }));
    assert_eq!(strict["error"]["code"], "invalid_request");

    let encoded = BASE64.encode(
        serde_json::to_vec(&json!({
            "protocol": "cocoa.checkpoint.v2",
            "operation": "probe",
            "gitExecutablePath": git_path.to_str().unwrap(),
        }))
        .unwrap(),
    );
    let frame = cocoa_workspace_helper::run_argv(vec![OsString::from(encoded)]);
    assert!(frame.starts_with(b"CCH1 "));
    let newline = frame.iter().position(|byte| *byte == b'\n').unwrap();
    let unsupported: Value = serde_json::from_slice(&frame[newline + 1..]).unwrap();
    assert_eq!(unsupported["error"]["code"], "unsupported_protocol");

    let oversized = format!(
        "{{\"protocol\":\"{PROTOCOL}\",\"operation\":\"probe\",\"gitExecutablePath\":\"{}\",\"padding\":\"{}\"}}",
        git_path.display(),
        "x".repeat(65_536)
    );
    let frame = cocoa_workspace_helper::run_argv(vec![OsString::from(BASE64.encode(oversized))]);
    assert!(frame.starts_with(b"CCH1 "));
    let newline = frame.iter().position(|byte| *byte == b'\n').unwrap();
    let response: Value = serde_json::from_slice(&frame[newline + 1..]).unwrap();
    assert_eq!(response["error"]["code"], "request_too_large");
    assert_eq!(response["error"]["retryable"], false);
}

#[test]
fn linked_worktree_has_distinct_git_directory_and_shared_common_directory() {
    let (temp, root, git_path) = repository();
    let linked = temp.path().join("linked");
    git(
        &git_path,
        &root,
        &[
            "worktree",
            "add",
            "--quiet",
            "-b",
            "linked-test",
            linked.to_str().unwrap(),
        ],
    );
    let binding = open(&linked, &git_path);
    assert_ne!(
        binding["gitDirectoryRoot"]["canonicalPath"],
        binding["gitCommonDirectoryRoot"]["canonicalPath"]
    );
    assert!(binding["gitDirectoryRoot"]["canonicalPath"]
        .as_str()
        .unwrap()
        .starts_with(
            binding["gitCommonDirectoryRoot"]["canonicalPath"]
                .as_str()
                .unwrap()
        ));
    let (captured, _) = capture(&linked, &git_path, &binding, OP1, CHECKPOINT1);
    assert_eq!(captured["ok"], true, "{captured:#}");
}
