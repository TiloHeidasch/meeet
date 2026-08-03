# syntax=docker/dockerfile:1.7
#
# This is intentionally a source build.  The repository, release tag, commit,
# and both base-image digests are supplied by an operator-owned manifest rather
# than being silently selected by this Dockerfile.
# Upstream project: graphhopper/graphhopper, release tag: 10.2.

ARG GRAPHOPPER_BUILD_IMAGE
ARG GRAPHOPPER_RUNTIME_IMAGE
FROM ${GRAPHOPPER_BUILD_IMAGE} AS build

ARG GRAPHOPPER_RELEASE=10.2
ARG GRAPHOPPER_SOURCE_REPOSITORY
ARG GRAPHOPPER_SOURCE_COMMIT
ARG GRAPHOPPER_BUILD_IMAGE

USER root
RUN printf '%s\n' "${GRAPHOPPER_BUILD_IMAGE}" | grep -Eq '^([^@[:space:]]+)/[^@[:space:]]+@sha256:[0-9a-f]{64}$'
RUN apt-get update \
  && apt-get install --no-install-recommends --yes ca-certificates git \
  && rm -rf /var/lib/apt/lists/*

RUN test -n "${GRAPHOPPER_SOURCE_REPOSITORY}" \
  && test -n "${GRAPHOPPER_SOURCE_COMMIT}" \
  && case "${GRAPHOPPER_SOURCE_REPOSITORY}" in \
       https://*|ssh://*|git@*) ;; \
       *) echo "GRAPHOPPER_SOURCE_REPOSITORY must be an explicit HTTPS or SSH repository" >&2; exit 1 ;; \
     esac \
  && test "$(printf '%s' "${GRAPHOPPER_SOURCE_COMMIT}" | wc -c)" -eq 40 \
  && case "${GRAPHOPPER_SOURCE_COMMIT}" in *[!0-9a-fA-F]*|'') exit 1 ;; esac

WORKDIR /src
RUN git init . \
  && git remote add upstream "${GRAPHOPPER_SOURCE_REPOSITORY}" \
  && git fetch --depth=1 upstream \
       "${GRAPHOPPER_SOURCE_COMMIT}" \
       "refs/tags/${GRAPHOPPER_RELEASE}:refs/tags/${GRAPHOPPER_RELEASE}" \
  && test "$(git rev-list -n 1 "refs/tags/${GRAPHOPPER_RELEASE}")" = "${GRAPHOPPER_SOURCE_COMMIT}" \
  && git checkout --detach "${GRAPHOPPER_SOURCE_COMMIT}"

# Compile only the web distribution and its dependencies from the checked-out
# release.  The exact commit check above prevents a movable branch from being
# used as the release source.
RUN mvn --batch-mode --no-transfer-progress \
  -DskipTests \
  -Dmaven.javadoc.skip=true \
  -pl web -am package

RUN set -eu \
  && jar_path="$(find /src/web/target -maxdepth 1 -type f -name 'graphhopper-web-*.jar' ! -name '*sources*' ! -name '*javadoc*' -print -quit)" \
  && test -n "${jar_path}" \
  && mkdir -p /out \
  && cp "${jar_path}" /out/graphhopper-web.jar

FROM ${GRAPHOPPER_RUNTIME_IMAGE} AS runtime

ARG GRAPHOPPER_RELEASE=10.2
ARG GRAPHOPPER_RUNTIME_IMAGE
ARG GRAPHOPPER_SOURCE_COMMIT
LABEL org.opencontainers.image.title="meeet GraphHopper router" \
      org.opencontainers.image.description="Project-owned GraphHopper image built from a verified upstream release" \
      org.opencontainers.image.version="${GRAPHOPPER_RELEASE}" \
      org.opencontainers.image.revision="${GRAPHOPPER_SOURCE_COMMIT}"

USER root
RUN printf '%s\n' "${GRAPHOPPER_RUNTIME_IMAGE}" | grep -Eq '^([^@[:space:]]+)/[^@[:space:]]+@sha256:[0-9a-f]{64}$'
RUN apt-get update \
  && apt-get install --no-install-recommends --yes ca-certificates coreutils \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --system --gid 10001 graphhopper \
  && useradd --system --uid 10001 --gid 10001 --home-dir /nonexistent --no-create-home --shell /usr/sbin/nologin graphhopper \
  && mkdir -p /etc/graphhopper /data/input/osm /data/logs \
  && chown -R 10001:10001 /data

COPY --from=build /out/graphhopper-web.jar /opt/graphhopper/graphhopper-web.jar
COPY entrypoint.sh /usr/local/bin/meeet-graphhopper-entrypoint
RUN chown -R 10001:10001 /opt/graphhopper \
  && chmod 0555 /usr/local/bin/meeet-graphhopper-entrypoint

USER 10001:10001
WORKDIR /data
EXPOSE 8989
ENTRYPOINT ["/usr/local/bin/meeet-graphhopper-entrypoint"]
CMD ["server", "/etc/graphhopper/config.yml"]
