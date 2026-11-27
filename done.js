// Garmin Connect normally catches the redirect to this page and closes it.
// If it doesn't (or the page was opened in a normal browser), offer the code.
const code = new URLSearchParams(location.search).get("r") || "";
const box = document.getElementById("code");
box.value = code;
if (!code) document.getElementById("manual").hidden = true;
document.getElementById("copy").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(code);
  } catch {
    box.focus();
    box.select();
    document.execCommand("copy");
  }
  document.getElementById("copied").hidden = false;
});
