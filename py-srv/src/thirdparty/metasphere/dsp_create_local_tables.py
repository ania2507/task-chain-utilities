from metasphere.src.dsp.dsp_handler import DSPHandler
from metasphere.src.dsp.dsp_space_handler import DSPSpace
import time
from metasphere.src.tools.dsp_tools import exec_command
from metasphere.src.tools.rest_tools import rest_post_api


def dsp_create_local_tables_cli(space, object_type, object_name, json_tgt):
    dsp = DSPHandler()
    comand = dsp.cli_create_object_string(space, object_type, object_name, json_tgt)
    result = exec_command(comand)
    return result

def dsp_create_single_local_tables_rest(dsp: DSPHandler, space, json_in, object_name):
    """
    Crea e attiva una local table tramite REST API.
    Args:
        dsp (DSPHandler): Istanza di DSPHandler o compatibile.
        space (str): Nome dello space.
        json_in (dict): Definizione oggetto.
        object_name (str): Nome oggetto da creare.
    Returns:
        int: Status code della risposta finale, oppure 0 in caso di errore.
    """

    space_obj = DSPSpace(dsp, space)
    if not space_obj.space_id:
        raise ValueError(f"Space '{space_obj.space_name}' not found or not accessible.")

    hostname = dsp.hostname
    access_token = dsp.access_token

    # Costruisci il payload per il create object
    space_id = space_obj.space_id
    definitions = json_in.get("definitions")
    version = json_in.get("version", {"csn": "1.0"})
    meta = json_in.get("meta", {"kind": "csnImport", "label": object_name})
    content = {
        "version": version,
        "meta": meta,
        "definitions": definitions
    }
    data = {
        "name": object_name,
        "space_id": space_id,
        "content": content,
        "async": True,
        "saveAction": "import",
        "customValidationOptions": {"allowBackwardTransitions": True}
    }
    payload = {"data": data}

    url = f"{hostname}/deepsea/repository/{space}/objects/"
    response = rest_post_api(url, access_token, payload)
    if response == 0:
        print(f"ERRORE: Esecuzione interrotta in dsp_create_single_local_tables_rest durante creazione oggetto su {url}")
        return None
    
    time.sleep(10)

    object_name_no_ext = object_name.replace('.json', '') if object_name.endswith('.json') else object_name
    objectIds = space_obj.get_object_id_by_name(object_name_no_ext, space_obj.space_id)
    if objectIds is None:
        print(f"ERRORE: Esecuzione interrotta in dsp_create_single_local_tables_rest durante recupero object_id per {object_name_no_ext} nello space {space_obj.space_id}")
        return 0
    folderGuid = space_obj.space_id

    payload = {
        "folderGuid": folderGuid,
        "objectIds": [objectIds] if objectIds else [],
        "spaceName": space_obj.space_name
    }

    # Actiavate Object 
    url = f"{hostname}/dwaas-core/deploy/{space_obj.space_name}/objects/"
    response = rest_post_api(url, access_token, payload)
    if response == 0:
        print(f"ERRORE: Esecuzione interrotta in dsp_create_single_local_tables_rest durante attivazione oggetto su {url}")
        return 0
    time.sleep(10)

    # Check if the object is active
    # TODO get to api rest
    
    return 1