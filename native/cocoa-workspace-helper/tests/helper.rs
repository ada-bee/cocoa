use std::ffi::OsString;
use std::fs;
use std::os::unix::ffi::OsStringExt;
use std::os::unix::fs::symlink;
use std::path::Path;
use std::process::Command;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tempfile::TempDir;

fn invoke(request: Value) -> (Value, usize, Vec<u8>) {
    let encoded = BASE64.encode(serde_json::to_vec(&request).unwrap());
    decode_frame(cocoa_workspace_helper::run_argv(vec![OsString::from(
        encoded,
    )]))
}

fn decode_frame(frame: Vec<u8>) -> (Value, usize, Vec<u8>) {
    let newline = frame.iter().position(|byte| *byte == b'\n').unwrap();
    let header = std::str::from_utf8(&frame[..newline]).unwrap();
    let fields: Vec<_> = header.split(' ').collect();
    assert_eq!(fields.len(), 3);
    assert_eq!(fields[0], "CWH1");
    let declared = fields[1].parse::<usize>().unwrap();
    let payload = frame[newline + 1..].to_vec();
    assert_eq!(declared, payload.len());
    assert_eq!(fields[2], format!("{:x}", Sha256::digest(&payload)));
    assert!(frame.is_ascii(), "v1 frame must be ASCII");
    let response = serde_json::from_slice(&payload).unwrap();
    (response, payload.len(), frame)
}

fn invoke_process(request: Value, home: Option<&Path>) -> (Value, usize, Vec<u8>) {
    let encoded = BASE64.encode(serde_json::to_vec(&request).unwrap());
    let mut command = Command::new(env!("CARGO_BIN_EXE_cocoa-workspace-helper"));
    command.arg(encoded);
    match home {
        Some(path) => {
            command.env("HOME", path);
        }
        None => {
            command.env_remove("HOME");
        }
    }
    let output = command.output().unwrap();
    assert!(output.status.success());
    assert!(output.stderr.is_empty());
    decode_frame(output.stdout)
}

fn validate(root: &std::path::Path) -> Value {
    let (response, _, _) = invoke(json!({
        "protocol": 1,
        "operation": "validate",
        "root": root.to_str().unwrap(),
    }));
    assert_eq!(response["ok"], true);
    response["result"]["root"].clone()
}

fn rooted_request(operation: &str, root: &std::path::Path, identity: &Value) -> Value {
    json!({
        "protocol": 1,
        "operation": operation,
        "root": root.to_str().unwrap(),
        "expectedRoot": identity,
        "relativePath": "",
    })
}

#[test]
fn probe_and_validate_match_v1_contract() {
    let (probe, _, _) = invoke(json!({"protocol": 1, "operation": "probe"}));
    assert_eq!(probe["ok"], true);
    assert_eq!(probe["result"]["operation"], "probe");
    assert_eq!(probe["result"]["capabilities"].as_array().unwrap().len(), 6);
    assert!(probe["result"]["capabilities"]
        .as_array()
        .unwrap()
        .contains(&json!("browse")));

    let temp = TempDir::new().unwrap();
    let root = temp.path().join("workspace");
    fs::create_dir(&root).unwrap();
    let alias = temp.path().join("alias");
    symlink(&root, &alias).unwrap();
    let identity = validate(&alias);
    assert_eq!(identity["canonicalRoot"], root.to_str().unwrap());
    assert!(identity["device"]
        .as_str()
        .unwrap()
        .bytes()
        .all(|b| b.is_ascii_digit()));
    assert!(identity["inode"]
        .as_str()
        .unwrap()
        .bytes()
        .all(|b| b.is_ascii_digit()));
}

#[test]
fn stat_reports_leaf_symlink_but_traversal_and_read_reject_it() {
    let temp = TempDir::new().unwrap();
    let root = temp.path().join("workspace");
    let outside = temp.path().join("outside");
    fs::create_dir(&root).unwrap();
    fs::create_dir(&outside).unwrap();
    fs::write(outside.join("secret"), b"outside").unwrap();
    symlink(&outside, root.join("escape")).unwrap();
    let identity = validate(&root);

    let mut stat = rooted_request("stat", &root, &identity);
    stat["relativePath"] = json!("escape");
    let (leaf, _, _) = invoke(stat);
    assert_eq!(leaf["ok"], true);
    assert_eq!(leaf["result"]["metadata"]["kind"], "symlink");

    let mut escaped = rooted_request("stat", &root, &identity);
    escaped["relativePath"] = json!("escape/secret");
    let (response, _, frame) = invoke(escaped);
    assert_eq!(response["ok"], false);
    assert_eq!(response["error"]["code"], "path_is_symlink");
    assert!(!String::from_utf8(frame)
        .unwrap()
        .contains(outside.to_str().unwrap()));

    let mut read = rooted_request("read", &root, &identity);
    read["relativePath"] = json!("escape");
    read["maxBytes"] = json!(32);
    let (response, _, _) = invoke(read);
    assert_eq!(response["error"]["code"], "path_is_symlink");
}

#[test]
fn every_later_operation_rechecks_root_identity() {
    let temp = TempDir::new().unwrap();
    let root = temp.path().join("workspace");
    let displaced = temp.path().join("displaced");
    fs::create_dir(&root).unwrap();
    fs::write(root.join("before"), b"before").unwrap();
    let identity = validate(&root);

    fs::rename(&root, &displaced).unwrap();
    fs::create_dir(&root).unwrap();
    fs::write(root.join("after"), b"after").unwrap();

    let request = rooted_request("stat", &root, &identity);
    let (response, _, _) = invoke(request);
    assert_eq!(response["ok"], false);
    assert_eq!(response["error"]["code"], "invalid_root");
}

#[test]
fn reads_exact_limit_and_one_byte_over_with_consistent_lengths() {
    let temp = TempDir::new().unwrap();
    let root = temp.path().join("workspace");
    fs::create_dir(&root).unwrap();
    fs::write(root.join("exact"), b"1234").unwrap();
    fs::write(root.join("over"), b"12345").unwrap();
    let identity = validate(&root);

    for (path, length, truncated) in [("exact", 4, false), ("over", 5, true)] {
        let mut request = rooted_request("read", &root, &identity);
        request["relativePath"] = json!(path);
        request["maxBytes"] = json!(4);
        let (response, _, _) = invoke(request);
        assert_eq!(response["ok"], true);
        assert_eq!(response["result"]["byteLength"], length);
        assert_eq!(response["result"]["truncated"], truncated);
        assert_eq!(
            BASE64
                .decode(response["result"]["dataBase64"].as_str().unwrap())
                .unwrap(),
            b"1234"
        );
    }
}

#[test]
fn direct_listing_is_sorted_and_truncated_by_entry_and_response_caps() {
    let temp = TempDir::new().unwrap();
    let root = temp.path().join("workspace");
    fs::create_dir(&root).unwrap();
    for name in ["zeta", "alpha", "middle", "café"] {
        fs::write(root.join(name), b"x").unwrap();
    }
    fs::create_dir(root.join("directory")).unwrap();
    symlink("alpha", root.join("link")).unwrap();
    let identity = validate(&root);

    let mut request = rooted_request("list", &root, &identity);
    request["limits"] = json!({
        "maxEntries": 25000,
        "maxDepth": 1,
        "maxDirectories": 1,
        "maxResponseBytes": 8 * 1024 * 1024,
    });
    let (response, _, _) = invoke(request.clone());
    assert_eq!(response["result"]["truncated"], false);
    let paths: Vec<_> = response["result"]["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| entry["path"].as_str().unwrap())
        .collect();
    let mut sorted = paths.clone();
    sorted.sort();
    assert_eq!(paths, sorted);
    assert_eq!(
        response["result"]["entries"]
            .as_array()
            .unwrap()
            .iter()
            .find(|entry| entry["path"] == "link")
            .unwrap()["kind"],
        "symlink"
    );

    request["limits"]["maxEntries"] = json!(2);
    let (response, _, _) = invoke(request.clone());
    assert_eq!(response["result"]["entries"].as_array().unwrap().len(), 2);
    assert_eq!(response["result"]["truncated"], true);

    request["limits"]["maxEntries"] = json!(25_000);
    request["limits"]["maxResponseBytes"] = json!(145);
    let (response, payload_bytes, _) = invoke(request);
    assert_eq!(response["ok"], true);
    assert!(payload_bytes <= 145);
    assert_eq!(response["result"]["truncated"], true);
    assert!(response["result"]["entries"].as_array().unwrap().len() < 6);
}

#[test]
fn recursive_listing_honors_depth_and_normalizes_relative_paths() {
    let temp = TempDir::new().unwrap();
    let root = temp.path().join("workspace");
    fs::create_dir_all(root.join("dir/deep")).unwrap();
    fs::write(root.join("root-file"), b"root").unwrap();
    fs::write(root.join("dir/child"), b"child").unwrap();
    fs::write(root.join("dir/deep/grandchild"), b"grandchild").unwrap();
    let identity = validate(&root);

    let expected = [
        (0, Vec::<&str>::new()),
        (1, vec!["dir", "root-file"]),
        (2, vec!["dir", "dir/child", "dir/deep", "root-file"]),
        (
            3,
            vec![
                "dir",
                "dir/child",
                "dir/deep",
                "dir/deep/grandchild",
                "root-file",
            ],
        ),
    ];
    for (depth, expected_paths) in expected {
        let mut request = rooted_request("list", &root, &identity);
        request["limits"] = json!({
            "maxEntries": 100,
            "maxDepth": depth,
            "maxDirectories": 100,
            "maxResponseBytes": 8192,
        });
        let (response, _, _) = invoke(request);
        assert_eq!(response["ok"], true);
        assert_eq!(response["result"]["truncated"], false);
        let paths: Vec<_> = response["result"]["entries"]
            .as_array()
            .unwrap()
            .iter()
            .map(|entry| entry["path"].as_str().unwrap())
            .collect();
        assert_eq!(paths, expected_paths);
    }
}

#[test]
fn recursive_listing_bounds_scanned_directories_and_never_follows_symlinks() {
    let temp = TempDir::new().unwrap();
    let root = temp.path().join("workspace");
    let outside = temp.path().join("outside");
    fs::create_dir_all(root.join("a")).unwrap();
    fs::create_dir_all(root.join("b")).unwrap();
    fs::create_dir_all(&outside).unwrap();
    fs::write(root.join("a/inside-a"), b"a").unwrap();
    fs::write(root.join("b/inside-b"), b"b").unwrap();
    fs::write(outside.join("secret"), b"secret").unwrap();
    symlink(&outside, root.join("escape")).unwrap();
    let identity = validate(&root);

    let mut request = rooted_request("list", &root, &identity);
    request["limits"] = json!({
        "maxEntries": 100,
        "maxDepth": 4,
        "maxDirectories": 2,
        "maxResponseBytes": 8192,
    });
    let (response, _, _) = invoke(request);
    assert_eq!(response["ok"], true);
    assert_eq!(response["result"]["truncated"], true);
    let paths: Vec<_> = response["result"]["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| entry["path"].as_str().unwrap())
        .collect();
    assert!(paths.contains(&"a/inside-a"));
    assert!(!paths.contains(&"b/inside-b"));
    assert!(paths.contains(&"escape"));
    assert!(!paths.iter().any(|path| path.contains("secret")));
}

#[test]
fn malformed_and_non_strict_requests_always_return_valid_frames() {
    for args in [
        vec![],
        vec![OsString::from("not-base64")],
        vec![OsString::from(BASE64.encode(b"not-json"))],
        vec![OsString::from(
            BASE64.encode(br#"{"protocol":1,"operation":"unknown"}"#),
        )],
        vec![OsString::from(BASE64.encode(
            br#"{"protocol":1,"operation":"probe","extra":true}"#,
        ))],
    ] {
        let (response, _, _) = decode_frame(cocoa_workspace_helper::run_argv(args));
        assert_eq!(response["protocol"], 1);
        assert_eq!(response["ok"], false);
    }
}

#[test]
fn binary_expects_exactly_one_argument_and_keeps_stderr_empty() {
    let output = Command::new(env!("CARGO_BIN_EXE_cocoa-workspace-helper"))
        .args(["one", "two"])
        .output()
        .unwrap();
    assert!(output.status.success());
    assert!(output.stderr.is_empty());
    let (response, _, _) = decode_frame(output.stdout);
    assert_eq!(response["error"]["code"], "invalid_path");
}

#[test]
fn invalid_paths_and_errors_never_echo_raw_host_paths() {
    let sensitive = "/private/secret/workspace";
    let (response, _, frame) = invoke(json!({
        "protocol": 1,
        "operation": "validate",
        "root": sensitive,
    }));
    assert_eq!(response["ok"], false);
    assert!(!String::from_utf8(frame).unwrap().contains(sensitive));

    let temp = TempDir::new().unwrap();
    let root = temp.path().join("workspace");
    fs::create_dir(&root).unwrap();
    let identity = validate(&root);
    for path in ["/absolute", "../escape", "a//b", "a\\b", "a\0b"] {
        let mut request = rooted_request("stat", &root, &identity);
        request["relativePath"] = json!(path);
        let (response, _, frame) = invoke(request);
        assert_eq!(response["error"]["code"], "invalid_path");
        assert!(!String::from_utf8(frame).unwrap().contains(path));
    }
}

#[test]
fn browse_resolves_filesystem_root_and_home_without_recursive_entries() {
    let (root_response, _, _) = invoke(json!({
        "protocol": 1,
        "operation": "browse",
        "locator": {"kind": "absolute", "path": "/"},
        "maxEntries": 1,
        "maxResponseBytes": 4096,
    }));
    assert_eq!(root_response["ok"], true);
    assert_eq!(root_response["result"]["directoryPath"], "/");
    assert_eq!(root_response["result"]["parentPath"], Value::Null);

    let temp = TempDir::new().unwrap();
    let home = temp.path().join("home");
    fs::create_dir_all(home.join("Developer/nested")).unwrap();
    fs::write(home.join("Developer/project"), b"project").unwrap();
    fs::write(home.join("Developer/nested/hidden"), b"hidden").unwrap();
    let (response, _, _) = invoke_process(
        json!({
            "protocol": 1,
            "operation": "browse",
            "locator": {"kind": "home", "relativePath": "Developer"},
            "maxEntries": 100,
            "maxResponseBytes": 8192,
        }),
        Some(&home),
    );
    assert_eq!(response["ok"], true);
    assert_eq!(
        response["result"]["directoryPath"],
        home.join("Developer").to_str().unwrap()
    );
    assert_eq!(response["result"]["parentPath"], home.to_str().unwrap());
    let names: Vec<_> = response["result"]["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| entry["name"].as_str().unwrap())
        .collect();
    assert_eq!(names, vec!["nested", "project"]);
    assert!(!names.contains(&"hidden"));
}

#[test]
fn browse_rejects_symlink_traversal_and_reports_leaf_symlink_entries() {
    let temp = TempDir::new().unwrap();
    let directory = temp.path().join("directory");
    let outside = temp.path().join("outside");
    fs::create_dir(&directory).unwrap();
    fs::create_dir(&outside).unwrap();
    symlink(&outside, directory.join("escape")).unwrap();

    let (response, _, _) = invoke(json!({
        "protocol": 1,
        "operation": "browse",
        "locator": {"kind": "absolute", "path": directory.to_str().unwrap()},
        "maxEntries": 100,
        "maxResponseBytes": 8192,
    }));
    assert_eq!(response["ok"], true);
    assert_eq!(response["result"]["entries"][0]["name"], "escape");
    assert_eq!(response["result"]["entries"][0]["kind"], "symlink");

    let (response, _, _) = invoke(json!({
        "protocol": 1,
        "operation": "browse",
        "locator": {
            "kind": "absolute",
            "path": directory.join("escape").to_str().unwrap(),
        },
        "maxEntries": 100,
        "maxResponseBytes": 8192,
    }));
    assert_eq!(response["ok"], false);
    assert_eq!(response["error"]["code"], "path_is_symlink");
}

#[test]
fn browse_enforces_entry_and_serialized_response_caps() {
    let temp = TempDir::new().unwrap();
    let directory = temp.path().join("directory");
    fs::create_dir(&directory).unwrap();
    for name in ["alpha-long-name", "beta-long-name", "gamma-long-name"] {
        fs::write(directory.join(name), b"x").unwrap();
    }
    let request = |max_entries, max_response_bytes| {
        json!({
            "protocol": 1,
            "operation": "browse",
            "locator": {"kind": "absolute", "path": directory.to_str().unwrap()},
            "maxEntries": max_entries,
            "maxResponseBytes": max_response_bytes,
        })
    };

    let (response, _, _) = invoke(request(2, 8192));
    assert_eq!(response["result"]["entries"].as_array().unwrap().len(), 2);
    assert_eq!(response["result"]["truncated"], true);

    let (_, full_payload_bytes, _) = invoke(request(100, 8192));
    let response_limit = full_payload_bytes - 1;
    let (response, payload_bytes, _) = invoke(request(100, response_limit));
    assert_eq!(response["ok"], true);
    assert!(payload_bytes <= response_limit);
    assert_eq!(response["result"]["truncated"], true);
    assert!(response["result"]["entries"].as_array().unwrap().len() < 3);
}

#[test]
fn browse_rejects_invalid_home_paths_and_non_utf8_entries() {
    let request = |locator| {
        json!({
            "protocol": 1,
            "operation": "browse",
            "locator": locator,
            "maxEntries": 100,
            "maxResponseBytes": 8192,
        })
    };
    let (response, _, _) =
        invoke_process(request(json!({"kind": "home", "relativePath": ""})), None);
    assert_eq!(response["error"]["code"], "invalid_root");

    let (response, _, _) = invoke_process(
        request(json!({"kind": "home", "relativePath": ""})),
        Some(Path::new("relative/home")),
    );
    assert_eq!(response["error"]["code"], "invalid_root");

    let temp = TempDir::new().unwrap();
    let home = temp.path().join("home");
    fs::create_dir(&home).unwrap();
    let (response, _, _) = invoke_process(
        request(json!({"kind": "home", "relativePath": "../escape"})),
        Some(&home),
    );
    assert_eq!(response["error"]["code"], "invalid_path");

    let invalid_name = OsString::from_vec(vec![b'b', b'a', b'd', 0xff]);
    match fs::write(home.join(invalid_name), b"x") {
        Ok(()) => {
            let (response, _, _) = invoke(request(json!({
                "kind": "absolute",
                "path": home.to_str().unwrap(),
            })));
            assert_eq!(response["error"]["code"], "operation_failed");
        }
        Err(error) => {
            #[cfg(target_os = "macos")]
            assert_eq!(error.raw_os_error(), Some(92));
            #[cfg(not(target_os = "macos"))]
            panic!("failed to create non-UTF-8 fixture: {error}");
        }
    }

    let invalid_absolute = format!("{}/../home", temp.path().display());
    let (response, _, _) = invoke(request(json!({
        "kind": "absolute",
        "path": invalid_absolute,
    })));
    assert_eq!(response["error"]["code"], "invalid_path");
}
