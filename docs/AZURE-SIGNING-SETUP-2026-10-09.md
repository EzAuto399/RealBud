# Azure Artifact Signing setup — 9 October 2026

Status: corrected organization identity validation submitted and **In Progress**.
This is not identity approval, certificate issuance, or proof of a signed build.

## Identity validation

The original request repeated its primary email as its secondary email. Microsoft
requires distinct addresses on the same domain, and submitted requests cannot be
edited. A secondary alias has now been saved in the existing business mailbox.
The corrected request was submitted from the business-email Azure login with the
owner's explicit approval of the terms and submission. The old request remains
intact. Use the new request when a verification action arrives.

The business-email login can create validation requests in the signing tenant.
A fresh sign-in to the **old** credentials link still returned `noPermission` and
showed the Microsoft consumer tenant. The exact reason for that access denial is
not established; adding Azure access did not by itself resolve the old link.

Microsoft documentation:
- [Identity validation requirements and correction procedure](https://learn.microsoft.com/en-us/azure/artifact-signing/quickstart#create-an-identity-validation-request)
- [Identity validation support](https://learn.microsoft.com/en-us/azure/artifact-signing/faq#what-if-i-need-assistance-with-identity-validation)

## Windows build activation

Existing GitHub variables: `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, and
`AZURE_SUBSCRIPTION_ID`. The account is `realbudsigning`, with East US endpoint
`https://eus.codesigning.azure.net/`.

`AZURE_SIGN_PROFILE` and `AZURE_SIGN_PUBLISHER` remain unset until a Public Trust
certificate profile exists. Do not fill these with a guessed profile or publisher.
After Microsoft approves the identity:

1. Create the Public Trust profile from the approved identity.
2. Confirm the existing GitHub service principal has Certificate Profile Signer
   access at the intended scope and federation restricted to this repository's main branch.
3. Set `AZURE_SIGN_PUBLISHER` to the exact certificate CN, then set `AZURE_SIGN_PROFILE`.
4. Run Package Windows on main; require the installer and application signature
   checks, timestamp checks, publisher checks, and installed runtime proof to pass.

The workflow uses Azure OIDC, prefetches the signing token, requires code signing
when enabled, and rejects unsigned or wrongly signed outputs. Manual builds of
other refs remain unsigned. A successful unsigned build does not prove Azure signing.

The first Azure login/signing and Windows signature verification remain untested
until identity approval and profile creation. No Windows release has been published
by this setup work.
