import json
from metasphere.src.tools.logger import get_metasphere_logger
from metasphere.src.dsp.dsp_handler import DSPHandler
from metasphere.src.tools.dsp_tools import exec_command
from metasphere.src.tools.rest_tools import rest_get_api, rest_post_api

cli_cmd_dsp_login = "datasphere login"
cli_cmd_get_secrets = "datasphere config secrets show"
cli_cmd_add_scope_to_space = "datasphere scoped-roles scopes assign -Q BWID_Master_Role -W " 
cli_cmd_add_user_to_space = "datasphere spaces users add -S "
cli_cmd_space_create = "datasphere spaces create -f "
cli_cmd_dsp_create_table = "datasphere objects local-tables create"

rest_object = "https://{hostname}/deepsea/repository/{space}/objects/"

logger = get_metasphere_logger(__name__)

class DSPSpace:
    
    def __init__(self, connection: DSPHandler, space_name: str):
        # Otteniamo il logger per questo modulo, così il logging sarà governato dal programma principale
        # e i messaggi saranno etichettati con 'metasphere.dsp_space_handler'.
        #self.logger = get_logger("metasphere.dsp_space_handler")
        logger.info(f"Inizializzazione DSPSpace per space: {space_name}")
        self.connection = connection
        self.space_name = space_name
        self.space_id = None
        self.qualified_name = None
        self.directory = None
        self._load_metadata()

    def _load_metadata(self):
        url = f"{self.connection.hostname}/deepsea/repository/objects/?qualifiedNames={self.space_name}"
        logger.info(f"Caricamento metadata per space: {self.space_name}")
        response = rest_get_api(url, self.connection.access_token)
        if response == 0:
            logger.error(f"Esecuzione interrotta: errore nella chiamata rest_get_api durante _load_metadata per space: {self.space_name}")
            print(f"ERRORE: Esecuzione interrotta in _load_metadata per space: {self.space_name}")
            return
        result = json.loads(response.content)
        if "results" in result and len(result["results"]) > 0:
            self.space_id = result["results"][0]["space_id"]
            self.qualified_name = result["results"][0]["qualified_name"]
            self.directory = self.get_folder_structure()
            logger.info(f"Directory tree generato per lo space '{self.space_name}'")
        else:
            logger.error(f"Space '{self.space_name}' non trovato")
            raise ValueError("Space not found")

    def get_folder_structure(self):
        url = f"{self.connection.hostname}/deepsea/repository/search/$all?%24top=30&%24skip=0&%24count=true&whyfound=true&valuehierarchy=folder_id&%24apply=filter(Search.search(query%3D'SCOPE%3ASEARCH_DESIGN%20(folder_id%3ADESCENDANT_OF%3A%22{self.space_id}%22%20AND%20kind%3AEQ(S)%3A%22sap.repo.folder%22)%20*'))"
        response = rest_get_api(url, self.connection.access_token)
        if response == 0:
            logger.error(f"Esecuzione interrotta: errore nella chiamata rest_get_api durante get_folder_structure per space_id: {self.space_id}")
            print(f"ERRORE: Esecuzione interrotta in get_folder_structure per space_id: {self.space_id}")
            return None
        data = json.loads(response.content)
        entries = data.get("value", [])
        
        # Costruiamo un mapping di ogni entry con il suo ID unico
        folder_by_id = {}
        for entry in entries:
            entry_id = entry.get("id")
            folder_name = entry.get("folder_name")
            if entry_id:
                folder_by_id[entry_id] = {
                    "id": entry_id,
                    "name": entry.get("name"),
                    "space_id": entry.get("space_id"),
                    "folder_name": folder_name,
                    "children": {}
                }
        
        # Costruiamo l'albero dalla gerarchia
        tree = {}
        
        for entry in entries:
            parent_hierarchy = entry.get("@com.sap.vocabularies.Search.v1.ParentHierarchies")
            entry_id = entry.get("id")
            
            if not parent_hierarchy or not entry_id:
                continue
            
            hierarchy_nodes = parent_hierarchy[0]["hierarchy"]
            
            # Costruiamo il path completo dalla gerarchia
            current = tree
            
            # Ogni nodo nella gerarchia rappresenta una cartella nel path
            for i, node in enumerate(hierarchy_nodes):
                node_folder_name = node.get("folder_name")
                if not node_folder_name:
                    continue
                
                # Se questa è l'ultima cartella nel path, usa i dati dell'entry corrente
                if i == len(hierarchy_nodes) - 1:
                    if node_folder_name not in current:
                        current[node_folder_name] = dict(folder_by_id.get(entry_id, {
                            "folder_name": node_folder_name,
                            "id": entry_id,
                            "children": {}
                        }))
                else:
                    # Per cartelle intermedie, crea una cartella base se non esiste
                    if node_folder_name not in current:
                        # Cerca un'entry che corrisponda a questa cartella intermedia
                        matching_entry_id = None
                        for other_entry in entries:
                            other_hierarchy = other_entry.get("@com.sap.vocabularies.Search.v1.ParentHierarchies")
                            if other_hierarchy:
                                other_nodes = other_hierarchy[0]["hierarchy"]
                                # Se questa entry ha una gerarchia che termina a questo livello
                                # e l'ultimo nodo corrisponde, allora questa entry rappresenta questa cartella
                                if (len(other_nodes) == i + 1 and 
                                    other_nodes[-1].get("folder_name") == node_folder_name):
                                    matching_entry_id = other_entry.get("id")
                                    break
                        
                        if matching_entry_id and matching_entry_id in folder_by_id:
                            current[node_folder_name] = dict(folder_by_id[matching_entry_id])
                        else:
                            # Cartella intermedia senza entry specifica
                            current[node_folder_name] = {
                                "folder_name": node_folder_name,
                                "children": {}
                            }
                
                # Naviga al livello children della cartella corrente
                current = current[node_folder_name]["children"]
        
        return tree

    def get_folder_id_by_name(self, name):
        #self.logger.info(f"Ricerca folder_id per nome: {name}")  # Log informativo: segnala la ricerca del folder_id
        """
        Restituisce l'id della directory dato il folder_name o il name.
        Cerca ricorsivamente nella struttura delle folder.
        """
        def search(tree):
            for folder in tree.values():
                if folder.get("folder_name") == name or folder.get("name") == name:
                    return folder.get("id")
                # Ricorsione sui figli
                found = search(folder.get("children", {}))
                if found:
                    return found
            return None
        return search(self.directory)

    def get_object_id_by_name(self, name, space_id):
        #self.logger.info(f"Ricerca object_id per nome: {name} e space_id: {space_id}")  # Log informativo: segnala la ricerca dell'object_id
        """
        Restituisce l'id dell'oggetto dato il nome, filtrando per space_id.
        """
        url = f"{self.connection.hostname}/deepsea/repository/objects/?qualifiedNames={name}"
        response = rest_get_api(url, self.connection.access_token)
        if response == 0:
            logger.error(f"Esecuzione interrotta: errore nella chiamata rest_get_api durante get_object_id_by_name per name: {name} e space_id: {space_id}")
            print(f"ERRORE: Esecuzione interrotta in get_object_id_by_name per name: {name} e space_id: {space_id}")
            return None
        result = json.loads(response.content)
        for obj in result.get("results", []):
            if obj.get("space_id") == space_id:
                return obj.get("id")
        return None
    

    def get_obj_metadata(self, obj_name):
        """
        Restituisce i dettagli di una tabella specificata dal nome.
        """
        obj_id = self.get_object_id_by_name(obj_name, self.space_id)
        if not obj_id:
            logger.error(f"Tabella '{obj_name}' non trovata nello space '{self.space_name}'")
            return None

        url = (
            f"{self.connection.hostname}/deepsea/repository/{self.space_name}/designObjects"
            f"?ids={obj_id}&details=id%2C%23fullCsn"
            "&kinds=entity%2Cview%2Csap.dwc.ermodel%2Csap.dis.dataflow%2Csap.dwc.taskChain"
            "%2Csap.dwc.analyticModel%2Csap.dwc.dac%2Csap.repo.folder%2Csap.dis.replicationflow"
            "%2Csap.dis.transformationflow%2Csap.dwc.perspective%2Csap.dwc.consumptionModel"
            "%2Csap.dwc.factModel%2Csap.dwc.businessEntity%2Csap.dwc.authscenario"
        )

        response = rest_get_api(url, self.connection.access_token)
        if response == 0:
            logger.error(f"Errore nella chiamata rest_get_api per get_table_details su '{obj_name}'")
            return None
        try:
            data = json.loads(response.content)
            full_csn = data['results'][0]['#fullCsn']
            return full_csn
        except (json.JSONDecodeError, KeyError, IndexError) as e:
            logger.error(f"Errore nella parsificazione o nella struttura JSON per '{obj_name}': {e}")
            return None

    @staticmethod
    def extract_technical_names_from_results(all_results):
        """
        Estrae tutti i valori technicalName da una lista di risultati JSON (stringhe o dict).
        """
        technical_names = []
        for result in all_results:
            # Se result è stringa, prova a fare il loads
            if isinstance(result, str):
                try:
                    data = json.loads(result)
                except Exception:
                    continue
            else:
                data = result
            # data può essere una lista o un dict con una chiave 'value' o simile
            if isinstance(data, dict) and 'value' in data:
                data = data['value']
            if isinstance(data, list):
                for item in data:
                    if isinstance(item, dict) and 'technicalName' in item:
                        technical_names.append(item['technicalName'])
            elif isinstance(data, dict) and 'technicalName' in data:
                technical_names.append(data['technicalName'])
        return technical_names

    def cli_get_all_objects(self, object_type):
        """
        Restituisce tutti gli oggetti di un tipo specifico nello spazio.
        Args:
            object_type (str): Il tipo di oggetto da elencare (es. 'local-tables', 'views', etc.).
        Returns:
            list: Una lista di oggetti del tipo specificato.
        """
        batch_size = 100
        all_results = []
        skip = 0
        while True:
            command = f'datasphere objects {object_type} list --top {batch_size} --skip {skip} --space {self.space_name}'
            result = exec_command(command)
            if result is None:
                logger.error(f"Errore durante l'esecuzione del comando: {command}")
                return None
            # Decodifica il risultato per controllare se è una lista vuota
            try:
                data = json.loads(result) if isinstance(result, str) else result
            except Exception:
                data = result
            # Se data è un dict con chiave 'value', estrai la lista
            if isinstance(data, dict) and 'value' in data:
                data_list = data['value']
            else:
                data_list = data if isinstance(data, list) else []
            if not data_list:
                break
            all_results.append(result)
            skip += batch_size

        # Estrai tutti i technicalName in una lista piatta
        technical_names = DSPSpace.extract_technical_names_from_results(all_results)
        return technical_names
        