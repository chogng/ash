# Docker Session runtime Provider

This optional product executable owns Docker provisioning. It registers the version 1
`sessionRuntime.v1` DataChannel through `ash-external-ext-sdk`; App Server consumes the
contract without linking this crate. The Docker daemon owns container state and labels.

Use **Agents: New Session in Dev Container...** in the Agents window. Select a local
workspace containing `.devcontainer/devcontainer.json` or `.devcontainer.json`. Install
Docker and the [official Dev Container CLI](https://github.com/devcontainers/cli) on that
host. The Provider runs `devcontainer up`, probes the container's architecture/libc, and
installs the compatible Ash Remote runtime from the product's authenticated Remote catalog
when the image does not already provide one. It verifies archive size, digest, package shape
and the installation receipt through shared Remote primitives; downloads run in a cancellable
owned helper process. It then creates a draft and routes first send into the container. The CLI owns image,
Dockerfile, Compose, Features, remote user/environment and configuration lifecycle semantics.

Preparation is cancellable. Configuration/CLI failures never select a local directory as
a fallback. Before admission, preparation completes the gateway's real initialize checks and
reads the container's Session catalog to verify protocol and capabilities. Container resource URIs preserve
authority; `SessionDirectory` binds file, terminal and Git calls to that Session.

Closing a window terminates its CLI/stdio process tree and leaves the container running.
**Stop Dev Container...** stops containers with this workspace's CLI label and retires their
connection admission while retaining the source authorization for later removal, even after
reopening the profile. The control picker reads this persisted inventory independently of the
Session catalog. **Remove Dev Container...** additionally removes those containers after explicit
confirmation; Docker volumes remain. Reopening the workspace runs `up` again and discovers
the container's durable Sessions. Provider disablement retires old activations and routes.

The product builder includes the binary as the optional `devContainerProvider` component.
No process starts just because the binary is installed. Development hosts may explicitly
select `ASH_DEV_CONTAINER_PROVIDER_PATH`; `ASH_DEVCONTAINER_CLI` and `ASH_DOCKER_PATH`
select trusted tool paths. Internal App Server credentials and model keys are excluded from
the Provider environment. Docker still owns its own configuration and credentials.

Validate with `just test ash-dev-container-provider`, `just test ash-app-server managed::gateway`
and the Sessions/renderer unit suites. The actual SDK process test covers registration,
invocation, unavailable tools/configuration, cancellation and disablement. This checkout's
host has no Docker, so a real-container smoke test remains unverified: start a configured
container, send a Session request, edit/read a file, run a terminal command, close/reopen the
window, then exercise Stop and Remove. Automatic installation requires a product with an
authenticated Remote catalog and the POSIX prerequisites checked by the shared installer
(including tar and SHA-256). An image with a compatible installed runtime also works.
The Provider does not copy host executables across operating systems.
