# com.xsec.workspace.approvals

This is the public source repository for `com.xsec.workspace.approvals`. It was materialized from
the immutable signed XSEC Marketplace release during the first-party source
migration. Develop on `beta`; merge reviewed, tested changes to `main` for the
Stable source line.

Marketplace artifacts, release indexes, signatures, and Factory adoption proof
remain in [tzf1003/xsec-plugins](https://github.com/tzf1003/xsec-plugins).
This source repository never stores Factory credentials or KMS material.

Source repository: <https://github.com/tzf1003/xsec-plugin-approvals>

## Source validation

Run `npm ci && npm run validate` before opening a pull request. The check validates
the full XSEC Desktop extension against the pinned Desktop schema snapshot, its
Frontend API and permission contract, all plugin-tree paths and entrypoints, and
the marketplace descriptor. It also syntax-checks the production frontend.

The schema snapshot is sourced from `desktop/packages/plugin-api/schemas/` in
the matching XSEC Desktop source revision. Update it together with the semantic
checks whenever Desktop changes the plugin contract.

## Release provenance

Factory records the exact Beta and Stable source revisions with each immutable
Approvals release. Published source revisions include the declared frontend
artifact validated by the source-validation command.
