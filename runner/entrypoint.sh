#!/bin/bash
# Runs one job with the JIT config the agent passed in, then exits (and the container is removed). Gives up when no
# job has started after JITRUNNER_IDLE_SECONDS: GitHub may have handed that job to another runner.
set -uo pipefail
idle=${JITRUNNER_IDLE_SECONDS:-300}
(
	sleep "$idle"
	if ! compgen -G "/opt/actions-runner/_diag/Worker_*" >/dev/null; then
		echo "jitrunner: no job after ${idle}s, giving up"
		pkill -TERM -f Runner.Listener
	fi
) &
exec ./run.sh --jitconfig "$JIT_CONFIG"
