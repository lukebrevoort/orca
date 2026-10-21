FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4 AS bun
FROM python:3.13-bookworm@sha256:073ffebb96ae4d0ed73ccad59f08c47bd84af8a79f5258130f8458ac50ad9ff4 AS runtime-base
USER root
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
RUN git --version && python3 --version && timeout --version && test "$(bun --version)" = 1.3.14
FROM runtime-base AS comparison
COPY staging/railway-search /harness
RUN sh /harness/prepare-sources.sh
# Harness imports resolve against candidate's independently frozen dependencies.
RUN ln -s /sources/head/node_modules /harness/node_modules
WORKDIR /harness
ENTRYPOINT ["timeout", "--signal=TERM", "--kill-after=5s", "1200s", "python3", "/harness/run.py"]
