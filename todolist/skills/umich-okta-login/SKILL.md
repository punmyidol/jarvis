---
name: umich-okta-login
description: Get through the U-M Okta sign-in (okta.umich.edu / Weblogin) push-approval step inside a todolist task agent, alerting the user in the todolist UI with the exact number to tap in Okta Verify. Use when a browser tab lands on an Okta page ("Verify it's you", "Get a push notification", a number shown on screen) while working on Canvas, Wolverine Access, umich Gmail or other umich.edu sites.
---

# U-M Okta push login

Since 2026-02-25 U-M signs in through Okta (replacing Weblogin + Duo). MFA is Okta Verify **push with number matching**: the sign-in page shows a number, the user's phone shows several, and they must tap the matching one (then Face ID). The user may be away from the computer, so you relay the number through the todolist UI (`okta.js`), which they can open from their phone.

`okta.js` is at `todolist/okta.js` next to `server.js` (the session conventions give its full path). It only works inside a todolist session.

## Flow

1. **Username / password.** Click Next / Sign in. Never type, request, or look for a password. Chrome autofill usually fills it. If the password field is still empty, run `node okta.js alert --password --site <host>`, leave the tab open, and hand back.
2. **Choose push.** Pick "Get a push notification" / Okta Verify. If it isn't offered, use "Verify with something else" and select the push option. Do NOT pick "Enter a code", and never take a Duo path.
3. **Read the number.** Use `get_page_text` / `read_page` to find the number Okta displays. It must be 1-2 digits. Re-read it immediately before alerting, since a new push shows a new number.
4. **Alert.** `node okta.js alert <number> --site <host>`.
5. **Wait.** Poll the tab every ~5 s for up to ~2 min (`tabs_context_mcp` URL / `get_page_text`). Success = the tab navigates off okta.umich.edu to the site you wanted.
6. **Finish.** On success, `node okta.js clear` and continue the task.
7. **Rejected / timed out.** Click "Send push again" **once**, read the NEW number, alert again (go to step 4). If it fails again: `node okta.js alert --failed --site <host>` and hand back with the tab left open.

## Rules

- At most 2 pushes per task. Each one buzzes the user's phone and repeated failures can lock the account.
- Run `okta.js clear` on every exit path, including hand-back after success elsewhere and giving up. A leftover alert shows a stale number (it auto-expires after 3 min, but don't rely on that).
- You never approve the push yourself and never try to bypass MFA. If the user's session is still valid there is no prompt; check before alerting.
- Out of scope: Duo (still used for SSH/RDP/VPN until 2026-12-01), FastPass (needs the user at the Mac), storing credentials.

## Unknowns (record what you observe here)

U-M doesn't publish: how long a push stays valid, how long an Okta session lasts, whether a "keep me signed in" option is offered, or any rate limit on pushes. Update this section after real runs.
