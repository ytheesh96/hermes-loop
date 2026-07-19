# Hermes Loop v0.17.0-loop.1

This is the first public Hermes Loop desktop release. It adds the durable Loop
task graph and review/handoff workflow on top of Hermes Agent.

## Download

Download `Hermes-0.17.0-mac-arm64.dmg` from this release. This artifact is for
Apple-silicon (`arm64`) Macs. Windows, Linux, and Intel Mac artifacts are not
included in this release.

Open the DMG, drag **Hermes** to **Applications**, and launch it. Do not use the
upstream Hermes Agent installers or `hermes desktop` command to install this
fork; those target `NousResearch/hermes-agent` rather than
`ytheesh96/hermes-loop`.

## macOS Gatekeeper notice

This build does not carry an Apple Developer ID signature and is not
Apple-notarized. It is not claimed to pass normal Gatekeeper assessment. If
macOS blocks the first launch, Control-click **Hermes** in Applications, choose
**Open**, then confirm **Open**.