# Shared by the verify-ducked-init shell scripts. Source this file; do not execute it.
# shellcheck shell=bash

verify_state_root() {
  printf '%s' "${VERIFY_STATE_ROOT:-/tmp/verify-ducked-init}"
}

verify_sq() {
  local s=$1
  s=${s//\'/\'\\\'\'}
  printf "'%s'" "$s"
}

verify_load_state() {
  local root dir target=${1:-}
  root=$(verify_state_root)
  if [[ -n $target ]]; then
    if [[ -d $target ]]; then
      dir=$target
    elif [[ -d $root/$target ]]; then
      dir=$root/$target
    else
      echo "no verification state: $target" >&2
      exit 1
    fi
  elif [[ -n ${VERIFY_STATE_DIR:-} ]]; then
    dir=$VERIFY_STATE_DIR
  elif [[ -e $root/current ]]; then
    dir=$(readlink -f "$root/current")
  else
    echo "no current verification instance. Run scripts/launch.sh first." >&2
    exit 1
  fi
  if [[ ! -f $dir/state.env ]]; then
    echo "missing $dir/state.env" >&2
    exit 1
  fi
  # shellcheck disable=SC1090
  set -a
  source "$dir/state.env"
  set +a
  STATE_DIR=$dir
}

verify_repo_root() {
  cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd
}

# Kill only this pid and its descendants. Do not match by process name.
verify_kill_tree() {
  local pid=$1 child
  [[ -n $pid ]] || return 0
  kill -0 "$pid" 2>/dev/null || return 0
  local children
  children=$(ps -o pid= --ppid "$pid" 2>/dev/null || true)
  for child in $children; do
    verify_kill_tree "$child"
  done
  kill "$pid" 2>/dev/null || true
}

# Print pids that are listening on TCP $1. Uses /proc because ss/lsof are not required.
verify_listener_pids() {
  local port=$1
  python3 - "$port" <<'PY'
import os, sys
port = int(sys.argv[1])
hexport = f"{port:04X}"
inodes = set()
for name in ("/proc/net/tcp", "/proc/net/tcp6"):
    try:
        lines = open(name).read().splitlines()[1:]
    except OSError:
        continue
    for line in lines:
        parts = line.split()
        local, state, inode = parts[1], parts[3], parts[9]
        if local.split(":")[1].upper() == hexport and state == "0A":
            inodes.add(inode)
found = []
for pid in os.listdir("/proc"):
    if not pid.isdigit():
        continue
    fd_dir = f"/proc/{pid}/fd"
    try:
        names = os.listdir(fd_dir)
    except OSError:
        continue
    for name in names:
        try:
            target = os.readlink(f"{fd_dir}/{name}")
        except OSError:
            continue
        if target.startswith("socket:[") and target[8:-1] in inodes:
            found.append(pid)
            break
print("\n".join(found))
PY
}

verify_pid_is_descendant() {
  local pid=$1 root=$2 hops=0 ppid
  while [[ -n $pid && $pid != 0 && $pid != 1 && $hops -lt 40 ]]; do
    [[ $pid == "$root" ]] && return 0
    ppid=$(awk '/^PPid:/ { print $2 }' "/proc/$pid/status" 2>/dev/null || true)
    [[ -n $ppid ]] || return 1
    pid=$ppid
    hops=$((hops + 1))
  done
  return 1
}
