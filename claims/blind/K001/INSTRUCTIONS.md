You are writing an implementation of "MUSUBI settle core v0" from its specification alone. The full specification (SETTLE_CORE_v0.md) is below, followed by the input files of one test vector so you can see the file layout. You have not been given, and must not assume, any expected outputs, reference code or other implementations.

Write ONE Python 3 program, `settle.py`, using only the Python standard library (no third-party packages; implement Ed25519 verification, SHA-256 based checks and anything else yourself or with `hashlib`).

Interface:

- It is run as `python3 settle.py <vector_dir>`.
- `<vector_dir>` contains:
  - `contract.json`: the `contract` input (2.1 item 1)
  - `view.json`: the `view` input (2.1 item 3)
  - `events/`: a directory; each file in it holds one element of the `events` list (2.1 item 2). If the directory is missing, `events` is an empty list.
  - `nenrin/`: optional directory; each file holds one element of `nenrin_records` (2.1 item 4). Missing directory means absent.
  - `parent.json`: optional, the `parent` input (2.1 item 5).
  - Every file is UTF-8 text and is read according to section 2.2.
- On success it prints exactly one JSON object to stdout holding the eight core fields of section 9.1 (`contract_sha256`, `verdict`, `status`, `bond_outcome`, `deviation_codes`, `underspecified_reasons`, `event_set`, `dispositions`) and exits 0.
- If the inputs produce no settlement (section 2.2 errors), it prints `{"error": "<short reason>"}` and exits 2.

Return the complete program in a single fenced code block marked ```python. Put nothing that is part of the program outside that block. You may write notes after the block about places where you found the text ambiguous and how you read them.
