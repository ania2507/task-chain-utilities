import re
    
def find_distinct_folders(json_obj):
    """
    Trova tutte le stringhe distinte che corrispondono al pattern 'Folder_XXXXXXX' in un JSON.

    Args:
        json_obj (dict or list): Il JSON da analizzare.

    Returns:
        set: Un insieme di stringhe uniche corrispondenti al pattern.
    """
    folders = set()

    if isinstance(json_obj, dict):
        # Cerca in ogni valore del dizionario
        for value in json_obj.values():
            folders.update(find_distinct_folders(value))
    elif isinstance(json_obj, list):
        # Cerca in ogni elemento della lista
        for item in json_obj:
            folders.update(find_distinct_folders(item))
    elif isinstance(json_obj, str):
        # Cerca corrispondenze nella stringa
        matches = re.findall(r'Folder_[A-Z0-9]+', json_obj)
        folders.update(matches)

    return folders