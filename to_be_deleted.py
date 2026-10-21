# Ignore this file, it is only used for testing purposes.

import fnmatch
from pyarrow import fs

S3A_PREFIX = "s3a://"
GLOB_CHARS = set("*?[")


def list_parquet_files_s3(path, recursive=True):
    """Return all .parquet files under an s3a:// location, as s3a:// paths.

    Supports wildcards (*, ?, [abc]) in folder or file names, e.g.
      s3a://bucket/table/*
      s3a://bucket/table/part-*
      s3a://bucket/table/date=2026-10-*/
    A wildcard matches within one folder level only, as in Spark.

    Skips hidden/system paths (any folder or file starting with '_' or '.'),
    e.g. _temporary/ or _delta_log/, the same way Spark does when reading.
    """
    if not path.startswith(S3A_PREFIX):
        raise ValueError(f"Expected an s3a:// path, got: {path}")

    parts = path[len(S3A_PREFIX):].rstrip("/").split("/")

    # Fixed part (bucket/prefix) = everything before the first wildcard segment
    first_glob = next(
        (i for i, p in enumerate(parts) if GLOB_CHARS & set(p)), len(parts)
    )
    if first_glob == 0:
        raise ValueError("Wildcards in the bucket name aren't supported")
    base, pattern = "/".join(parts[:first_glob]), parts[first_glob:]

    # pyarrow only understands s3://, so swap the scheme for the lookup
    s3, root = fs.FileSystem.from_uri("s3://" + base)
    infos = s3.get_file_info(
        fs.FileSelector(root, recursive=recursive or bool(pattern))
    )

    # Non-recursive: files matched by the pattern, or directly inside a matched folder
    max_depth = None if recursive else len(pattern) + 1

    parquet_files = []
    for info in infos:
        if info.type != fs.FileType.File:
            continue
        if not info.path.lower().endswith(".parquet"):
            continue
        rel = info.path[len(root):].lstrip("/").split("/")
        if len(rel) < len(pattern):
            continue
        if max_depth is not None and len(rel) > max_depth:
            continue
        if not all(fnmatch.fnmatchcase(s, p) for s, p in zip(rel, pattern)):
            continue
        if any(s.startswith(("_", ".")) for s in rel):
            continue
        parquet_files.append(S3A_PREFIX + info.path)

    return sorted(parquet_files)