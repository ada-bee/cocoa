/**
 * Inline, read-only implementation of CocoaWorkspaceHelperV1 for POSIX Python 3.
 *
 * The request is a base64-encoded JSON argv value. Results are emitted as one
 * length- and SHA-256-framed ASCII payload so transport truncation cannot be
 * mistaken for a valid helper response.
 */
export const CODEX_WORKSPACE_HELPER_FRAME_PREFIX = "CWH1";

export const CODEX_WORKSPACE_INLINE_PYTHON = String.raw`
import base64
import collections
import errno
import hashlib
import json
import os
import stat
import sys

PROTOCOL = 1
MAX_PATH_BYTES = 4096
MAX_READ_BYTES = 1024 * 1024
MAX_LIST_ENTRIES = 25000
MAX_LIST_DEPTH = 64
MAX_LIST_DIRECTORIES = 10000
MAX_RESPONSE_BYTES = 8 * 1024 * 1024
MAX_SAFE_INTEGER = 9007199254740991
FRAME_PREFIX = b"CWH1"

class HelperError(Exception):
    def __init__(self, code, message):
        self.code = code
        self.safe_message = message
        super().__init__(message)

def response_error(code, message):
    return {"protocol": PROTOCOL, "ok": False, "error": {"code": code, "message": message}}

def encode_payload(value):
    return json.dumps(value, ensure_ascii=True, separators=(",", ":")).encode("ascii")

def emit(value, limit=MAX_RESPONSE_BYTES):
    payload = encode_payload(value)
    if len(payload) > limit:
        payload = encode_payload(response_error("limit_exceeded", "Helper response exceeded its byte limit."))
    digest = hashlib.sha256(payload).hexdigest().encode("ascii")
    header = FRAME_PREFIX + b" " + str(len(payload)).encode("ascii") + b" " + digest + b"\n"
    sys.stdout.buffer.write(header)
    sys.stdout.buffer.write(payload)

def require_object(value, code="invalid_path"):
    if not isinstance(value, dict):
        raise HelperError(code, "Expected an object.")
    return value

def require_int(value, minimum, maximum, message):
    if not isinstance(value, int) or isinstance(value, bool) or value < minimum or value > maximum:
        raise HelperError("limit_exceeded", message)
    return value

def validate_component(component):
    if component in ("", ".", "..") or "\\" in component or "\x00" in component:
        raise HelperError("invalid_path", "Path contains an invalid component.")
    try:
        encoded = component.encode("utf-8")
    except UnicodeEncodeError:
        raise HelperError("invalid_path", "Path is not valid UTF-8.")
    if len(encoded) > MAX_PATH_BYTES:
        raise HelperError("invalid_path", "Path component is too long.")

def split_relative(path):
    if not isinstance(path, str) or path.startswith("/") or "\\" in path or "\x00" in path:
        raise HelperError("invalid_path", "Path must be a normalized relative POSIX path.")
    if len(path.encode("utf-8")) > MAX_PATH_BYTES:
        raise HelperError("invalid_path", "Path is too long.")
    if path == "":
        return []
    components = path.split("/")
    for component in components:
        validate_component(component)
    return components

def split_root(path):
    if not isinstance(path, str) or not path.startswith("/") or "\\" in path or "\x00" in path:
        raise HelperError("invalid_root", "Root must be an absolute POSIX path.")
    if len(path.encode("utf-8")) > MAX_PATH_BYTES or os.path.normpath(path) != path:
        raise HelperError("invalid_root", "Root must be normalized.")
    if path == "/":
        return []
    components = path[1:].split("/")
    for component in components:
        validate_component(component)
    return components

def directory_flags():
    required = ("O_RDONLY", "O_DIRECTORY", "O_NOFOLLOW", "O_CLOEXEC")
    if os.name != "posix" or any(not hasattr(os, name) for name in required):
        raise HelperError("unsupported_operation", "Descriptor-relative POSIX traversal is unavailable.")
    return os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC

def map_os_error(error, fallback="operation_failed"):
    if error.errno == errno.ENOENT:
        return HelperError("path_not_found", "Path was not found.")
    if error.errno == errno.ENOTDIR:
        return HelperError("path_not_directory", "Path is not a directory.")
    if error.errno == errno.ELOOP:
        return HelperError("path_is_symlink", "Symbolic-link traversal is forbidden.")
    return HelperError(fallback, "Provider-host filesystem operation failed.")

def open_child_directory(parent_fd, component):
    try:
        return os.open(component, directory_flags(), dir_fd=parent_fd)
    except OSError as error:
        if error.errno == errno.ENOTDIR:
            try:
                value = os.stat(component, dir_fd=parent_fd, follow_symlinks=False)
                if stat.S_ISLNK(value.st_mode):
                    raise HelperError("path_is_symlink", "Symbolic-link traversal is forbidden.")
            except HelperError:
                raise
            except OSError:
                pass
        raise map_os_error(error)

def open_root(root):
    components = split_root(root)
    try:
        current = os.open("/", directory_flags())
    except OSError as error:
        raise map_os_error(error, "invalid_root")
    try:
        for component in components:
            child = open_child_directory(current, component)
            os.close(current)
            current = child
        return current
    except BaseException:
        os.close(current)
        raise

def identity(root, root_stat):
    return {"canonicalRoot": root, "device": str(root_stat.st_dev), "inode": str(root_stat.st_ino)}

def verify_root(request):
    root = request.get("root")
    expected = require_object(request.get("expectedRoot"), "invalid_root")
    root_fd = open_root(root)
    actual_stat = os.fstat(root_fd)
    actual = identity(root, actual_stat)
    if expected != actual:
        os.close(root_fd)
        raise HelperError("invalid_root", "Workspace root identity changed.")
    return root_fd

def open_relative_directory(root_fd, components):
    current = os.dup(root_fd)
    try:
        for component in components:
            child = open_child_directory(current, component)
            os.close(current)
            current = child
        return current
    except BaseException:
        os.close(current)
        raise

def open_parent(root_fd, components):
    if not components:
        return os.dup(root_fd), None
    return open_relative_directory(root_fd, components[:-1]), components[-1]

def entry_kind(mode):
    if stat.S_ISREG(mode):
        return "file"
    if stat.S_ISDIR(mode):
        return "directory"
    if stat.S_ISLNK(mode):
        return "symlink"
    return "other"

def safe_integer(value):
    value = int(value)
    if value < -MAX_SAFE_INTEGER or value > MAX_SAFE_INTEGER:
        raise HelperError("operation_failed", "Filesystem metadata exceeded the safe integer range.")
    return value

def metadata(value):
    result = {"kind": entry_kind(value.st_mode)}
    if stat.S_ISREG(value.st_mode):
        result["size"] = safe_integer(value.st_size)
    if hasattr(value, "st_birthtime"):
        result["createdAtMs"] = safe_integer(round(value.st_birthtime * 1000))
    result["modifiedAtMs"] = safe_integer(value.st_mtime_ns // 1000000)
    return result

def stat_relative(root_fd, path):
    components = split_relative(path)
    if not components:
        return os.fstat(root_fd)
    parent, name = open_parent(root_fd, components)
    try:
        return os.stat(name, dir_fd=parent, follow_symlinks=False)
    except OSError as error:
        raise map_os_error(error)
    finally:
        os.close(parent)

def valid_entry_name(name):
    if name in ("", ".", "..") or "/" in name or "\\" in name or "\x00" in name:
        raise HelperError("operation_failed", "Directory contains an invalid entry name.")
    try:
        encoded = name.encode("utf-8")
    except UnicodeEncodeError:
        raise HelperError("operation_failed", "Directory contains a non-UTF-8 entry name.")
    if len(encoded) > MAX_PATH_BYTES or any(0xD800 <= ord(character) <= 0xDFFF for character in name):
        raise HelperError("operation_failed", "Directory contains a non-UTF-8 entry name.")

def list_response(request, root_fd):
    limits = require_object(request.get("limits"))
    max_entries = require_int(limits.get("maxEntries"), 1, MAX_LIST_ENTRIES, "Invalid entry limit.")
    max_depth = require_int(limits.get("maxDepth"), 0, MAX_LIST_DEPTH, "Invalid depth limit.")
    max_directories = require_int(limits.get("maxDirectories"), 1, MAX_LIST_DIRECTORIES, "Invalid directory limit.")
    response_limit = require_int(limits.get("maxResponseBytes"), 1, MAX_RESPONSE_BYTES, "Invalid response limit.")
    directory_fd = open_relative_directory(root_fd, split_relative(request.get("relativePath")))
    entries = []
    truncated = False
    if max_depth > 0:
        pending = collections.deque([([], 0)])
        directories_scanned = 0
        try:
            while pending:
                if directories_scanned == max_directories:
                    truncated = True
                    break
                relative_directory, depth = pending.popleft()
                directories_scanned += 1
                opened_fd = open_relative_directory(directory_fd, relative_directory)
                direct_entries = []
                try:
                    with os.scandir(opened_fd) as iterator:
                        for entry in iterator:
                            if len(entries) + len(direct_entries) == max_entries:
                                truncated = True
                                break
                            valid_entry_name(entry.name)
                            try:
                                value = entry.stat(follow_symlinks=False)
                            except OSError as error:
                                raise map_os_error(error)
                            direct_entries.append((entry.name, entry_kind(value.st_mode)))
                finally:
                    os.close(opened_fd)
                direct_entries.sort(key=lambda item: item[0])
                for name, kind in direct_entries:
                    components = relative_directory + [name]
                    path = "/".join(components)
                    child_depth = depth + 1
                    if kind == "directory" and child_depth < max_depth:
                        if directories_scanned + len(pending) < max_directories:
                            pending.append((components, child_depth))
                        else:
                            truncated = True
                    entries.append({"path": path, "kind": kind})
                if len(entries) == max_entries:
                    if pending:
                        truncated = True
                    break
        finally:
            os.close(directory_fd)
    else:
        os.close(directory_fd)
    entries.sort(key=lambda item: item["path"])

    def make(candidate, was_truncated):
        return {"protocol": PROTOCOL, "ok": True, "result": {"operation": "list", "entries": candidate, "truncated": was_truncated}}

    response = make(entries, truncated)
    if len(encode_payload(response)) <= response_limit:
        return response, response_limit
    low = 0
    high = len(entries)
    while low < high:
        middle = (low + high + 1) // 2
        if len(encode_payload(make(entries[:middle], True))) <= response_limit:
            low = middle
        else:
            high = middle - 1
    candidate = make(entries[:low], True)
    if len(encode_payload(candidate)) > response_limit:
        raise HelperError("limit_exceeded", "Directory response byte limit is too small.")
    return candidate, response_limit

def read_response(request, root_fd):
    max_bytes = require_int(request.get("maxBytes"), 1, MAX_READ_BYTES, "Invalid read limit.")
    components = split_relative(request.get("relativePath"))
    if not components:
        raise HelperError("path_not_file", "Workspace root is not a file.")
    parent, name = open_parent(root_fd, components)
    flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC
    try:
        try:
            file_fd = os.open(name, flags, dir_fd=parent)
        except OSError as error:
            raise map_os_error(error)
    finally:
        os.close(parent)
    try:
        value = os.fstat(file_fd)
        if not stat.S_ISREG(value.st_mode):
            raise HelperError("path_not_file", "Path is not a regular file.")
        chunks = []
        remaining = max_bytes + 1
        while remaining > 0:
            chunk = os.read(file_fd, min(65536, remaining))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        observed = b"".join(chunks)
    finally:
        os.close(file_fd)
    byte_length = safe_integer(max(value.st_size, len(observed)))
    truncated = byte_length > max_bytes or len(observed) > max_bytes
    data = observed[:max_bytes]
    return {"protocol": PROTOCOL, "ok": True, "result": {"operation": "read", "dataBase64": base64.b64encode(data).decode("ascii"), "byteLength": byte_length, "truncated": truncated}}

def dispatch(request):
    request = require_object(request)
    if request.get("protocol") != PROTOCOL:
        raise HelperError("unsupported_protocol", "Unsupported workspace helper protocol.")
    operation = request.get("operation")
    if operation == "probe":
        directory_flags()
        return {"protocol": PROTOCOL, "ok": True, "result": {"operation": "probe", "implementation": "cocoa-inline-python3", "capabilities": ["probe", "validate", "stat", "list", "read"]}}
    if operation == "validate":
        configured_root = request.get("root")
        split_root(configured_root)
        root = os.path.realpath(configured_root)
        split_root(root)
        root_fd = open_root(root)
        try:
            value = os.fstat(root_fd)
            return {"protocol": PROTOCOL, "ok": True, "result": {"operation": "validate", "root": identity(root, value), "metadata": metadata(value)}}
        finally:
            os.close(root_fd)
    if operation not in ("stat", "list", "read"):
        raise HelperError("unsupported_operation", "Unsupported workspace helper operation.")
    root_fd = verify_root(request)
    try:
        if operation == "stat":
            return {"protocol": PROTOCOL, "ok": True, "result": {"operation": "stat", "metadata": metadata(stat_relative(root_fd, request.get("relativePath")))}}
        if operation == "list":
            return list_response(request, root_fd)
        return read_response(request, root_fd)
    finally:
        os.close(root_fd)

try:
    if len(sys.argv) != 2:
        raise HelperError("invalid_path", "Expected one encoded helper request.")
    encoded_request = sys.argv[1]
    if len(encoded_request) > 131072:
        raise HelperError("limit_exceeded", "Encoded request is too large.")
    decoded_request = base64.b64decode(encoded_request.encode("ascii"), validate=True)
    if len(decoded_request) > 65536:
        raise HelperError("limit_exceeded", "Decoded request is too large.")
    request = json.loads(decoded_request.decode("utf-8"))
    outcome = dispatch(request)
    if isinstance(outcome, tuple):
        emit(outcome[0], outcome[1])
    else:
        emit(outcome)
except HelperError as error:
    emit(response_error(error.code, error.safe_message))
except BaseException:
    emit(response_error("operation_failed", "Workspace helper operation failed."))
`;
