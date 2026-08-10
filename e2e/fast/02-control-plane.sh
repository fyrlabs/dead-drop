# How a user reaches their own runtime.
#
# The control plane is the one interface that is deliberately not on the
# network: a Unix socket at mode 0600, or a Windows named pipe, never TCP
# (invariant 3, ADR 0003). The socket path also has a hard 104-byte limit on
# both macOS and Linux, and a data directory deep enough to blow through it is
# reachable straight from the quick start, because `ddrop init` writes a
# relative `.deaddrop` that resolves against the working directory. That once
# killed `start` with a bare EINVAL naming no cause.

scenario "a user reaches their own runtime, and nobody else can"

CP="$WORK/control-plane"
SHARED="$CP/store"
mkdir -p "$SHARED"

write_config "$CP/peer" "cp-peer" "$(fs_transport "$SHARED")"
CP_PID=$(start_peer "$CP/peer" "$CP/peer.log")

ON_FAIL="$CP/peer.log"
can "start a runtime and talk to it over its control socket" \
  wait_up "$CP/peer" "$CP_PID"
ON_FAIL=""

SOCK=$(socket_path "$CP/peer.log")
note "control plane at $SOCK"

# Two separate promises: it is a socket in the filesystem rather than a port,
# and only its owner may open it. A regression to TCP would break the first; a
# regression in the umask would break the second and be invisible otherwise.
cannot "reach the control plane over the network: it is a filesystem socket, not a port" \
  [ -S "$SOCK" ]

mode=$(ls -l "$SOCK" 2>/dev/null | cut -c1-10)
cannot "open another user's control socket, which is the door to every workspace secret (mode $mode)" \
  [ "$mode" = "srw-------" ]

# Addressing the socket directly has to work too: it is the documented escape
# hatch when a data directory is somewhere awkward.
can "address a runtime by its socket path with --socket" \
  quietly $DDROP status --socket "$SOCK"

stop_peer "$CP_PID"

scenario "a data directory too deep for a Unix socket still works"

# 104 bytes is the platform limit on `sun_path`. Build a path comfortably past
# it, the way a project nested a few directories down would.
DEEP="$WORK/deep"
segment="nested-directory-segment"
for _ in 1 2 3 4 5; do DEEP="$DEEP/$segment"; done
mkdir -p "$DEEP"
natural="$DEEP/.deaddrop/deaddrop.sock"
note "the natural socket path would be ${#natural} bytes, past the 104-byte limit"

write_config "$DEEP" "deep-peer" "$(fs_transport "$SHARED")"
DEEP_PID=$(start_peer "$DEEP" "$WORK/deep.log")

ON_FAIL="$WORK/deep.log"
can "start a runtime whose data directory is nested past the socket path limit" \
  wait_up "$DEEP" "$DEEP_PID"
ON_FAIL=""

bound=$(socket_path "$WORK/deep.log")
note "the runtime bound $bound instead (${#bound} bytes)"

# The fallback has to be deterministic, because the runtime and every client
# command derive it independently. If they disagreed, `start` would succeed and
# every other command would report a dead runtime with no explanation.
cannot "end up with an unreachable runtime: the socket moved out of the data directory, and the client still found it" \
  [ "$bound" != "$natural" ]

stop_peer "$DEEP_PID"
