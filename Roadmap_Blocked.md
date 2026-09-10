# Blocked

Work that cannot go further here. Each entry says exactly what would unblock it.

## G-05 — Signed Firefox build for permanent installs

**Blocked on: credentials.** Signing needs an AMO API key (a JWT issuer and secret) from an
addons.mozilla.org account, and `web-ext sign --channel unlisted` uploads the package to Mozilla
under that account. Neither the key nor the account exists in this environment, and neither can be
created without a person.

Everything else it needed is done: the Firefox package passes `web-ext lint` with no errors,
warnings or notices (G-24), and every release carries a source archive that reproduces the package
byte for byte, which is what AMO asks for when the submitted files came out of a build (G-35).

To unblock: create the API key at https://addons.mozilla.org/developers/addon/api/key/, put it in
the environment as `WEB_EXT_API_KEY` and `WEB_EXT_API_SECRET`, then

    npx web-ext sign --source-dir dist/firefox --channel unlisted --upload-source-code dist/glossa-source-vX.Y.Z.zip

and attach the signed `.xpi` it returns to the release.

Original item, for the record:

- [ ] G-05 — Signed Firefox build for permanent installs
  Research note 2026-09-10: blocked on G-24 (`data_collection_permissions` is mandatory for new AMO submissions since 2025-11-03) and G-35 (reproducible source archive; esbuild output triggers AMO's source-submission rule and a reviewer must rebuild a byte-identical XPI). The AMO API is v5; `web-ext sign --channel unlisted --upload-source-code`.
  Why: temporary add-ons vanish when Firefox closes. AMO unlisted signing is automated and needs no public listing.
  Evidence: README install section; Astra-Deck 2026-09-04 research confirmed unlisted signing works without a listing.
  Touches: tools/release-firefox.mjs (new, web-ext sign or the AMO API), README.md
  Acceptance: the release carries a signed `.xpi` that installs from `about:addons` and survives a restart.
  Complexity: M
