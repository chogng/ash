import re


def line_count(text):
    return len(re.split(r"\r\n|\r|\n", text))
