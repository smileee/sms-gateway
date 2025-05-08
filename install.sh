#!/bin/bash

# Get the current user's home directory
USER_HOME=$(eval echo ~$USER)

# Create a directory for the driver if it doesn't exist
DRIVER_DIR="$USER_HOME/SIM7600X-4G-HAT-Demo"
HOME_DIR="$USER_HOME/sms-gateway"
mkdir -p "$DRIVER_DIR"

# Download and extract the driver
echo "Downloading SIM7600X-4G-HAT driver..."
wget https://www.waveshare.com/w/upload/2/29/SIM7600X-4G-HAT-Demo.7z -O "$DRIVER_DIR/SIM7600X-4G-HAT-Demo.7z"

# Install p7zip if not already installed
if ! command -v 7z &> /dev/null; then
    echo "Installing p7zip..."
    sudo apt-get update
    sudo apt-get install -y p7zip-full
fi

# Extract the driver
echo "Extracting driver files..."
7z x "$DRIVER_DIR/SIM7600X-4G-HAT-Demo.7z" -r -o"$USER_HOME"

# Set permissions
echo "Setting permissions..."
sudo chmod 777 -R "$DRIVER_DIR"

# Navigate to the bcm2835 directory and make
echo "Building bcm2835 library..."
cd "$DRIVER_DIR/Raspberry/c/bcm2835"
make

echo "Installation completed!"
echo "Note: The sim7600_4G_hat_init command may not work, but this is normal."
echo "The system will work correctly after the make process." 

# Install nvm & Node.js 20 (LTS)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.5/install.sh | bash

# Load nvm into the current script so that the `nvm` command is available straight away
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"

# Install and activate Node.js v20
nvm install 20
nvm use 20

# Move to the project root to install dependencies
cd "$HOME_DIR"

# Install project dependencies and global tools
npm install -g pm2 yarn

# Install dependencies
yarn install
