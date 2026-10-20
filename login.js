// Log in / create account page.
import { $, api, auth, forgetGuestRounds, guestRoundIds, renderNav } from "./common.js";

let registering = location.hash === "#register";

function setMode(isRegister) {
  registering = isRegister;
  $("tab-login").classList.toggle("active", !isRegister);
  $("tab-register").classList.toggle("active", isRegister);
  $("confirm-row").hidden = !isRegister;
  $("rules").hidden = !isRegister;
  $("submit").textContent = isRegister ? "Create account" : "Log in";
  $("password").autocomplete = isRegister ? "new-password" : "current-password";
  $("error").textContent = "";
}

$("tab-login").addEventListener("click", () => setMode(false));
$("tab-register").addEventListener("click", () => setMode(true));

$("form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const username = $("username").value.trim();
  const password = $("password").value;
  if (registering && password !== $("confirm").value) {
    $("error").textContent = "The two passwords don't match.";
    return;
  }
  $("submit").disabled = true;
  $("error").textContent = "";
  try {
    const session = await api(registering ? "/api/register" : "/api/login", {
      method: "POST", body: { username, password },
    });
    auth.save(session);
    // Puzzles played as a guest in this browser move over to the account.
    const roundIds = guestRoundIds();
    if (roundIds.length) await api("/api/claim", { method: "POST", body: { roundIds } }).catch(() => {});
    forgetGuestRounds();
    location.href = "/";
  } catch (err) {
    $("error").textContent = err.message;
  } finally {
    $("submit").disabled = false;
  }
});

if (auth.user) {
  // Already logged in: nothing to do here.
  location.replace(`/profile.html?u=${encodeURIComponent(auth.user.username)}`);
}
setMode(registering);
renderNav();
