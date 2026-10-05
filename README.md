# Digital Dead Man's Switch

Encrypted legacy messaging with a staged release. A front-end prototype built for Innovision 2.0.

## What it does
1. The user protects a file or message and picks a Primary and a Secondary trustee.
2. The user checks in on a schedule. A missed check-in starts a grace period.
3. The Primary trustee is notified and has a confirmation window. If they do not confirm, the Secondary trustee is notified.
4. If nobody confirms, the final action chosen by the user runs: release or delete.

Content is encrypted in the browser with AES-GCM (Web Crypto API) before it is stored.

## Run it
Open `index.html` in a browser. No build step and no server needed.
Sign in with anything (demo login), then create a switch.

## Demo tips
- Choose a short interval ("Demo - 1 minute") and a short grace period.
- Use the Lifecycle page to simulate a missed check-in and skip stages without waiting.
- Notifications are simulated and shown on the Notifications page. Nothing is sent.

## Prototype limitations
- Data lives in `localStorage`. There is no backend or scheduler.
- The encryption key is stored next to the ciphertext, so this demonstrates the flow, not real secrecy.
- Files are limited to 1 MB.
- Login is a placeholder.

## Planned work
- Per-file keys and per-recipient key wrapping (each trustee decrypts with their own private key)
- Passphrase-based key recovery (scrypt or Argon2)
- Threshold key sharing among executors (Shamir's secret sharing)
- Real backend with a scheduler, email/SMS delivery, and audit logging
- Independent security audit and a pilot with journalists and NGOs

## Files
- `index.html` - page structure
- `style.css` - styles
- `app.js` - state, encryption, lifecycle logic
