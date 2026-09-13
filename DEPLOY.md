# Deploying to a free Oracle Cloud VPS

IRCTC's anti-bot layer blocks **headless** Chromium specifically (confirmed
directly by testing) but allows a normal, visible browser window. That rules
out typical serverless/PaaS hosting (no persistent process, no display) --
this needs a real VM with a virtual display (Xvfb). Oracle Cloud's "Always
Free" tier gives a genuinely free-forever VM that works for this.

## 1. Create the VM (you do this part)

1. Sign up at https://www.oracle.com/cloud/free/ (needs identity + card
   verification, but the Always Free resources are never charged).
2. Create a compute instance:
   - Shape: **VM.Standard.A1.Flex** (Ampere/ARM, Always Free -- up to 4 OCPU /
     24GB RAM total across your Always Free instances), or
     **VM.Standard.E2.1.Micro** (x86, Always Free) if A1 capacity isn't
     available in your region.
   - Image: **Ubuntu** (22.04 or 24.04).
   - Under "Add SSH keys", let Oracle generate a key pair and download the
     private key -- you'll need it to log in.
3. Once running, note the instance's **public IP address**.
4. Open the port the app will use: in the instance's **Virtual Cloud
   Network > Security Lists**, add an ingress rule allowing TCP port `4000`
   from `0.0.0.0/0` (or restrict the source if you prefer).
5. SSH in: `ssh -i <downloaded-key>.key ubuntu@<public-ip>`

## 2. Get the code onto the VM

Easiest: push this project to a (free) private/public GitHub repo, then on
the VM:

```bash
git clone <your-repo-url> irctc-vacancy-tool
cd irctc-vacancy-tool
```

(No git account? `scp -r -i <key> "irctc vacancy tool" ubuntu@<public-ip>:~` from
your PC works too, just slower.)

## 3. Run the setup script

```bash
bash server/deploy/setup.sh
```

This installs Node.js, Xvfb, Playwright's Chromium + OS deps, builds the
client, and installs/starts a systemd service (`irctc-vacancy`) that keeps
the app running (including across reboots and crashes).

## 4. Use it from your phone

Open `http://<public-ip>:4000` in your phone's browser. That's it -- no
domain or HTTPS needed for personal use (this app doesn't handle
passwords/payments). If you later want a real domain + free HTTPS, put
[Caddy](https://caddyserver.com/) in front of it once you have a domain
pointed at the VM's IP; ask and I'll set that up.

## Useful commands on the VM

```bash
sudo systemctl status irctc-vacancy   # is it running?
sudo journalctl -u irctc-vacancy -f   # live logs
sudo systemctl restart irctc-vacancy  # after pulling new code + rebuilding
```

## Updating after code changes

```bash
cd irctc-vacancy-tool
git pull
cd client && npm install && npm run build
cd ../server && npm install
sudo systemctl restart irctc-vacancy
```
