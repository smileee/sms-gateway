#!/bin/bash

# reset.sh – Diagnose and reboot the Waveshare SIM7600X 4G HAT
#
# 1. Stops any process that is currently holding the serial port (default /dev/ttyUSB3)
# 2. Pulses the PWRKEY GPIO to perform a hardware reset (default GPIO 26)
# 3. Waits for the USB modem to enumerate again and prints the resulting tty devices
#
# Usage: sudo ./reset.sh [SERIAL_PORT] [GPIO]
#        sudo ./reset.sh              # uses /dev/ttyUSB3 and GPIO 26
#        sudo ./reset.sh /dev/ttyUSB2 17

set -euo pipefail

SERIAL_PORT=${1:-/dev/ttyUSB3}
GPIO_NUM=${2:-26}

########################################
# 1. Kill processes holding the port   #
########################################

echo "[reset] Looking for processes using $SERIAL_PORT …"
PIDS=$(lsof -t "$SERIAL_PORT" || true)
if [ -n "$PIDS" ]; then
  echo "[reset] Terminating processes: $PIDS"
  # Try graceful SIGTERM first, then SIGKILL if still running
  kill $PIDS 2>/dev/null || true
  sleep 2
  kill -9 $PIDS 2>/dev/null || true
else
  echo "[reset] No processes are using $SERIAL_PORT"
fi

########################################
# 2. Pulse the PWRKEY line via GPIO    #
########################################

echo "[reset] Asserting PWRKEY on GPIO $GPIO_NUM …"

# Export if necessary
echo "$GPIO_NUM" > /sys/class/gpio/export 2>/dev/null || true

echo out > "/sys/class/gpio/gpio$GPIO_NUM/direction"
# Waveshare module expects a LOW pulse ≥ 200 ms to power-cycle

echo 0 > "/sys/class/gpio/gpio$GPIO_NUM/value"
sleep 0.5

echo 1 > "/sys/class/gpio/gpio$GPIO_NUM/value"

########################################
# 3. Wait for the modem to come back   #
########################################

echo "[reset] Waiting for modem USB interfaces to re-enumerate …"

MAX_WAIT=30               # seconds
ELAPSED=0
while ! ls "$SERIAL_PORT" &>/dev/null; do
  if [ "$ELAPSED" -ge "$MAX_WAIT" ]; then
    echo "[reset] Timed out waiting for $SERIAL_PORT to appear" >&2
    exit 1
  fi
  sleep 2
  ELAPSED=$((ELAPSED+2))
  echo -n "."
done

echo -e "\n[reset] Modem is back on $SERIAL_PORT"
ls -l /dev/ttyUSB* | grep ttyUSB || true

exit 0 