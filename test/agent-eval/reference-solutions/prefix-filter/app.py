def select_names(names, prefix):
    return [name for name in names if name.casefold().startswith(prefix.casefold())]
