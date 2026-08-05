# Finite Azure ML Spot acceptance lane

This is a third execution lane for one real image. It runs the accepted
TRELLIS image on one serverless Spot A100, passes the resulting GLB to the
accepted Blender image on one serverless Spot CPU node, downloads the final
animated GLB, and applies the repository's production GLB validator locally.
It does not create a standing API, replace either existing VM, or call Tripo
or another external generative modeler.

## Why this is distinct from the denied GPU VM request

Azure Machine Learning compute has quota separate from the core
`Microsoft.Compute` VM-family quota. A Spot serverless job consumes the Azure
Machine Learning regional low-priority-core pool. Microsoft documents that
low-priority quota as one regional total across VM families. The authoritative
read endpoint used by the preflight is:

`Microsoft.MachineLearningServices/locations/<region>/usages`, type
`Microsoft.MachineLearningServices/lowPriorityCores/usages`.

The same response is also checked for a workspace-level low-priority A100 cap.
If no workspace override exists, Microsoft documents that the workspace shares
the subscription limit; if an override exists, both remaining limits must be
at least 24 vCPUs.

Quota is not capacity. A job can still queue or be preempted. The pipeline is
finite, forces no retrying service, and has two-hour/one-hour step timeouts.

References:

- [Azure ML serverless compute](https://learn.microsoft.com/en-us/azure/machine-learning/how-to-use-serverless-compute?view=azureml-api-2)
- [Azure ML quota rules](https://learn.microsoft.com/en-us/azure/machine-learning/how-to-manage-quotas?view=azureml-api-2)
- [Azure ML usage REST API](https://learn.microsoft.com/en-us/rest/api/azureml/usages/list?view=rest-azureml-2025-12-01)
- [Azure ML pipeline YAML](https://learn.microsoft.com/en-us/azure/machine-learning/reference-yaml-job-pipeline?view=azureml-api-2)

## Current state: blocked before spend

The last read-only account probe found all of the following:

- the target subscription is enabled;
- `Microsoft.MachineLearningServices` is not registered;
- there is no Azure ML workspace;
- Azure ML quota therefore cannot yet be read authoritatively;
- Azure ML advertises `Standard_NC24ads_A100_v4` as low-priority capable in
  multiple candidate regions, but that is not an entitlement or a capacity
  guarantee;
- the current runtime lock has no accepted shared repository revision, and its
  Blender entry has not completed private readback.

No provider registration, workspace, identity, role assignment, image push,
model upload, quota request, or job submission is performed by the preflight.

## Required activation work

Every item below is an explicit Azure mutation and must be separately approved
before it is performed:

1. Register `Microsoft.MachineLearningServices` in the exact target
   subscription.
2. Create one Azure ML workspace in the selected region with a user-assigned
   managed identity. Serverless jobs do not support a system-assigned identity.
3. Give that identity read access to the model datastore and `AcrPull` on an
   admin-disabled private ACR.
4. Confirm at least 24 unused **Azure ML Total Cluster LowPriority Regional
   vCPUs** in that region. If the limit is too low, request the increase under
   the Azure Machine Learning workspace's **Usage + quotas**, not under core VM
   family quota.
5. Rebuild both runtime images from one future, full 40-hex repository
   revision. Complete private archive readback, push them to the target ACR,
   and record both immutable `@sha256:` references in the runtime lock.
6. Upload the already approved offline model bundle to one identity-backed
   Azure ML datastore without changing any model revision or manifest bytes.
7. Install Azure CLI `ml` extension 2.15.0 or newer in the isolated CLI profile.

The runtime-lock contract for each image is deliberately narrow:

```json
{
  "repositoryRevision": "<one-full-40-hex-repository-revision>",
  "images": [
    {
      "component": "trellis2-or-blender-worker",
      "repositoryRevision": "<the-same-full-revision>",
      "cacheState": "verified-private-readback",
      "registryImageRef": "<private-registry>/<repository>@sha256:<digest>"
    }
  ]
}
```

The preflight requires both unique component entries, the same revision on all
three bindings, exact immutable-reference equality, and a live read of each
digest from the target ACR. The historical independent image tags cannot pass.

## Configuration

Set these in the shell. Do not paste their values into the HTML tracker,
handoff, chat, screenshots, or logs. Account IDs, tenant IDs, and customer data
must not enter Git. The private ACR digest references are the one exception:
after explicit acceptance, they are deliberately recorded in the runtime lock
for provenance and must remain in an access-controlled repository.

Potentially sensitive account/resource identifiers:

- `AZURE_ML_CONFIG_DIR` — isolated authenticated Azure CLI profile directory
- `AZURE_ML_SUBSCRIPTION_ID`
- `AZURE_ML_TENANT_ID`
- `AZURE_ML_RESOURCE_GROUP`
- `AZURE_ML_WORKSPACE`
- `AZURE_ML_LOCATION` — normalized name such as `eastus2`
- `AZURE_ML_TRELLIS_IMAGE` — private ACR digest reference
- `AZURE_ML_BLENDER_IMAGE` — private ACR digest reference
- `AZURE_ML_MODELS_URI` — `azureml://datastores/.../paths/...`

Integrity values, not secrets:

- `AZURE_ML_MODELS_MANIFEST_SHA256`
- `AZURE_ML_RUNTIME_REPOSITORY_REVISION`

Local paths:

- `AZURE_ML_INPUT_IMAGE` — absolute path to the one consented real image
- `AZURE_ML_OUTPUT_DIR` — a new, nonexistent result directory

The real input image is uploaded to the workspace datastore during submission.
Treat the image as potentially sensitive personal data and only submit an image
the owner has approved for Azure processing.

## Safe sequence

From the repository root:

```bash
infra/azure/scripts/run-azureml-spot-job.sh plan
infra/azure/scripts/run-azureml-spot-job.sh validate
```

`plan` performs read-only Azure checks and local rendering. `validate` asks
Azure ML to validate the rendered job but does not submit it. Neither command
is a real end-to-end test.

Submission is refused unless all three exact confirmations are present:

```bash
export CONFIRM_AZURE_SPEND=YES
export CONFIRM_AZURE_ML_SPOT_SPEND=YES
export CONFIRM_ONE_REAL_IMAGE_E2E=YES
infra/azure/scripts/run-azureml-spot-job.sh submit
```

Immediately after Azure returns a job name, the script prints safe-stop and
resume commands using the already-set environment variables, without printing
the account identifiers. Cancelling the job is the correct safe stop if cost,
queue time, logs, or output look wrong.

## What constitutes an actual pass

Only the final `IN-HOUSE AZURE ML E2E PASS` line after all of these events is
accepted:

1. the A100 step imports the exact locked TRELLIS source and verifies every
   byte in the four-model offline bundle against the accepted manifest;
2. TRELLIS produces a new GLB from the real input image;
3. the Blender step runs the production rig pipeline and bakes named idle and
   walk clips;
4. final output contains PBR material/texture data, skin, joints, weights,
   resolved animation channels, and no external buffer/image URI;
5. the downloaded artifact and acceptance envelope agree byte-for-byte;
6. the local production validator accepts the downloaded final GLB.

A provider registration, quota approval, successful YAML validation, queued
job, GPU allocation, or base GLB by itself is not an end-to-end pass.
