from metasphere.src.dsp.dsp_handler import DSPHandler
from metasphere.src.tools.dsp_tools import exec_command


def dsp_create_view_cli(dsp: DSPHandler, space, object_name, json_tgt, overwrite=True):
    object_type = "views"
    result = dsp.cli_create_object(space, object_type, object_name, json_tgt, overwrite=overwrite)
    return result