from metasphere.src.dsp.dsp_handler import DSPHandler
from metasphere.src.tools.dsp_tools import exec_command

def dsp_check_object_exists(
    dsp: DSPHandler,
    space: str, 
    object_type: str, 
    object_name: str
    ) -> bool:
    
    out = dsp.check_object_exists(space, object_type, object_name)
    
    return out