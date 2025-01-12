import pika
import json
import pandas as pd
from minio import Minio
from io import StringIO
from minio.error import S3Error
from collections import defaultdict
import re
import threading
import os
import copy
import time

# behaviour parameter
timer_interval = 30 # waiting time in secdons after the last analyzed architecture before the results are exported

# RabbitMQ connection
amqpconnection = os.getenv("RABBITMQCONNECTION")
amqpuser = "user"
amqppassword = "password"

# MinIO-Client connection
minioClienthostname = os.getenv("MINIOCONNECTION")
minioAccesKey = "user"
minioSecretKey = "password"

minio_client = Minio(
    f"{minioClienthostname}:9000",
    access_key=minioAccesKey,
    secret_key=minioSecretKey,
    secure=False
)

# Dictionary to store all the graphs and infos about architecture contents
component_analysis_data = {
    'total_architectures': 0,
    'total_components': 0,
    'components': defaultdict(int),
    'unique_components': defaultdict(int),
    'total_relationships': 0,
    'relationships': defaultdict(int)
}
valid_architectures = []
invalid_architectures = {}
invalid_stats = {
    "unknown_components": {"occurence_per_architecture": defaultdict(int), "total_occurence": defaultdict(int)}, 
    "unknown_relationships": defaultdict(int),
    "unknown_subgraphs": defaultdict(int),
}

# timer constants
message_timer = None

# Start or reset the timer, after timer_interval seconds without new messages, analysis data will be saved
def reset_message_timer():
    global message_timer
    if message_timer:
        message_timer.cancel()  # stop active timer
    message_timer = threading.Timer(timer_interval, save_analysis_data)
    message_timer.start()  # (re)start timer

# Sort the dictionary according to the values in descending order
def sort_dict_by_value(d):
    return dict(sorted(d.items(), key=lambda item: item[1], reverse=True))

# conversion of the keys to strings, because some of them are tuples and can't be saved into a .json file
def convert_keys_to_strings(data):
    if isinstance(data, dict):
        return {str(key): convert_keys_to_strings(value) for key, value in data.items()}
    elif isinstance(data, list):
        return [convert_keys_to_strings(item) for item in data]
    else:
        return data

def save_analysis_data(output_dir="analysis_results"):

    print(f" [!] No new message for {timer_interval} seconds. Save analysis data")

    # Create directory if not exists
    os.makedirs(output_dir, exist_ok=True)

    # ------------------------
    # Save component_analysis_data
    global component_analysis_data
    local_component_analysis_data = copy.deepcopy(component_analysis_data)
    local_component_analysis_data["components"] = sort_dict_by_value(local_component_analysis_data["components"])
    local_component_analysis_data["unique_components"] = sort_dict_by_value(local_component_analysis_data["unique_components"])
    local_component_analysis_data["relationships"] = sort_dict_by_value(local_component_analysis_data["relationships"])
    local_component_analysis_data = convert_keys_to_strings(local_component_analysis_data)
    component_data_path = os.path.join(output_dir, "component_analysis_data.json")
    with open(component_data_path, "w", encoding="utf-8") as f:
        json.dump(local_component_analysis_data, f, indent=4)
    print(f" [i] Component analysis data saved to {component_data_path}")

    # ------------------------
    # Save valid_architectures
    global valid_architectures
    local_valid_architectures = copy.deepcopy(valid_architectures)
    local_valid_architectures = convert_keys_to_strings(local_valid_architectures)

    local_valid_architectures_data = {
        "total_valid_architectures": len(local_valid_architectures),
        "valid_architectures": local_valid_architectures
    }

    valid_architectures_path = os.path.join(output_dir, "valid_architectures.json")
    with open(valid_architectures_path, "w", encoding="utf-8") as f:
        json.dump(local_valid_architectures_data, f, indent=4)
    print(f" [i] Valid architectures saved to {valid_architectures_path}")

    # ------------------------
    # Save invalid_architectures
    global invalid_architectures
    local_invalid_architectures = copy.deepcopy(invalid_architectures)
    local_invalid_architectures = convert_keys_to_strings(local_invalid_architectures)

    local_invalid_architectures_data = {
        "total_invalid_architectures": len(local_invalid_architectures),
        "invalid_architectures": local_invalid_architectures
    }

    invalid_architectures_path = os.path.join(output_dir, "invalid_architectures.json")
    with open(invalid_architectures_path, "w", encoding="utf-8") as f:
        json.dump(local_invalid_architectures_data, f, indent=4)
    print(f" [i] Invalid architectures saved to {invalid_architectures_path}")

    # ------------------------
    # Save invalid stats
    global invalid_stats
    local_invalid_stats = copy.deepcopy(invalid_stats)
    local_invalid_stats["unknown_components"]["occurence_per_architecture"] = sort_dict_by_value(local_invalid_stats["unknown_components"]["occurence_per_architecture"])
    local_invalid_stats["unknown_components"]["total_occurence"] = sort_dict_by_value(local_invalid_stats["unknown_components"]["total_occurence"])
    local_invalid_stats["unknown_relationships"] = sort_dict_by_value(local_invalid_stats["unknown_relationships"])
    local_invalid_stats["unknown_subgraphs"] = sort_dict_by_value(local_invalid_stats["unknown_subgraphs"])
    local_invalid_stats = convert_keys_to_strings(local_invalid_stats)

    invalid_stats_path = os.path.join(output_dir, "invalid_stats.json")
    with open(invalid_stats_path, "w", encoding="utf-8") as f:
        json.dump(local_invalid_stats, f, indent=4)
    print(f" [i] Invalid architectures saved to {invalid_stats_path}")
    
# Removes '-<number>' from component to count Java and Java-2 each as a Java component
def simplify_component_name(comp):
    return re.sub(r'-\d+$', '', comp)

# Create subgraphs out of the unknowns relationships
def create_graphs(relationships):
    graphs = []
    visited = set()

    # Help function for depth search
    def dfs(node, current_graph):
        for rel in relationships:
            source, target, relationship = rel
            if source == node and (source, target, relationship) not in current_graph:
                current_graph.append((source, target, relationship))
                dfs(target, current_graph)  # Recursion

    for rel in relationships:
        source, target, relationship = rel
        if source not in visited:
            current_graph = []
            dfs(source, current_graph)
            graphs.append(current_graph)
            visited.update([source] + [target for _, target, _ in current_graph])

    # split up each graph so that a subgraph is created for every outbound relationship of the graph's source node
    subgraphs = []
    subgraph_counter = -1

    for graph in graphs:
        source_node = graph[0][0]
        for subgraph in graph:
            if subgraph[0] == source_node:
                subgraph_counter += 1
                subgraphs.append([])
                subgraphs[subgraph_counter].append(subgraph)
            else:
                subgraphs[subgraph_counter].append(subgraph)

    # Remove redudant subgraphs // subgraphs which are also part of another subgraph
    unique_graphs = []
    for i, graph in enumerate(subgraphs):
        is_subgraph = False
        for j, other_graph in enumerate(subgraphs):
            if i != j and set(graph).issubset(set(other_graph)):
                is_subgraph = True
                break
        if not is_subgraph:
            unique_graphs.append(graph)
    
    return unique_graphs

# Formats the unknown subgraph output
def format_graph_output(graphs):
    formatted_graphs = []
    for index, graph in enumerate(graphs, start=1):
        formatted_output = []
        previous_target = None
        for relationship in graph:
            source, target, rel_type = relationship
            if source != previous_target:
                formatted_output.append(f"{source} --'{rel_type}'--> {target}")
            else:
                formatted_output.append(f"--'{rel_type}'--> {target}")
            previous_target = target

        invalid_stats['unknown_subgraphs'][(" ".join(formatted_output))] += 1
        # Create formatted string
        formatted_graph = f"Unknown Graph {index}: " + " ".join(formatted_output)
        formatted_graphs.append(formatted_graph)

        # Otuput the formatted graph
        print(f" [i] {formatted_graph}")
        print(" [ ] ")

    return formatted_graphs

# Checks which relationships of the architecture are unknown/less-known and creates subgraphs out of it for further analysis
def search_unknown_subgraphs(orig_relationships, lower_percentage_limit):

    unknown_relationships = list(orig_relationships)
    num_analyzed_architectures = component_analysis_data['total_architectures']
    num_analyzed_relationships = component_analysis_data['total_relationships']

    for orig_rel in orig_relationships:
        source = simplify_component_name(orig_rel[0])
        target = simplify_component_name(orig_rel[1])
        relationship = orig_rel[2]
        rel = (source, target, relationship)
        rel_count = component_analysis_data['relationships'].get(rel, 0)

        if num_analyzed_architectures == 0:
            relationship_occurence_percentage = 0.00
        else:
            # What is the percentage of this relationship in the analyzed relationships?
            relationship_occurence_percentage = round(((rel_count / num_analyzed_relationships) * 100), 2)

        if relationship_occurence_percentage > lower_percentage_limit:
            unknown_relationships.remove(orig_rel)

    # Create graphs out of the unknown relationships
    graphs = create_graphs(unknown_relationships)

    # Format and output unknown subgraphs
    formatted_unkown_sugraphs = format_graph_output(graphs)

    return formatted_unkown_sugraphs

def analyse_components_and_relationships(orig_format, architecture_name, all_components_uniques, relationships):
    num_analyzed_architectures = component_analysis_data['total_architectures']
    num_analyzed_componentes = component_analysis_data['total_components']
    num_analyzed_relationships = component_analysis_data['total_relationships']

    print(f" [x] Analysis of architecture '{architecture_name}' in format '{orig_format}'.")
    print(f" [x] Architecture is compared to {num_analyzed_architectures} training architectures.")
    print(" [ ]")
    print(" [ ] +++ Analyzing architecture components +++")

    lower_percentage_limit_architectures = 3.00 # Limit value for architecture based comparisons below which a unique component is marked.
    lower_percentage_limit = 0.00 # Limit value for total component/relationship comparisons below which a component/relationship is marked.
    has_issue = False  # Flag to track if the architecture has any issues
    issues = {
        "components": {"occurence_per_architecture": [], "total_occurence": []}, 
        "relationships": [], 
        "unknown_subgraphs": []
    }

    for unique_comp in all_components_uniques:
        unique_comp_count = component_analysis_data['unique_components'].get(unique_comp, 0)
        comp_count = component_analysis_data['components'].get(unique_comp, 0)

        if num_analyzed_architectures == 0:
            component_unique_occurence_percentage = 0.00
            component_occurence_percentage = 0.00
        else:
            # In what percentage of architectures does the unique component occur?
            component_unique_occurence_percentage = round(((unique_comp_count / num_analyzed_architectures) * 100), 2)
            # What is the percentage of this component in the analyzed components?
            component_occurence_percentage = round(((comp_count / num_analyzed_componentes) * 100), 2)
        
        # Check for components which occur <= lower_percentage_limit
        if component_unique_occurence_percentage <= lower_percentage_limit_architectures:
            has_issue = True
            print(f" [!] The component '{unique_comp}' occurs in {component_unique_occurence_percentage} % of the architectures. --> This indicates that it is rarely used. Please double-check the utilization of this components.")
            issues["components"]["occurence_per_architecture"].append({"component": unique_comp, "percentage": component_unique_occurence_percentage})
            invalid_stats['unknown_components']["occurence_per_architecture"][unique_comp] += 1
        else:
            print(f" [x] The component '{unique_comp}' occurs in {component_unique_occurence_percentage} % of the architectures")
        
        if component_occurence_percentage <= lower_percentage_limit:
            has_issue = True
            print(f" [!] The component '{unique_comp}' occurs in {component_occurence_percentage} % of the analyzed components. --> Please check, if this component is 'common practice'. If you are building a 'niche application', it is possible that this component has not been used in our training datasets.")
            issues["components"]["total_occurence"].append({"component": unique_comp, "percentage": component_occurence_percentage})
            invalid_stats['unknown_components']["total_occurence"][unique_comp] += 1
        else:
            print(f" [x] The component '{unique_comp}' occurs in {component_occurence_percentage} % of the analyzed components")

    print(" [ ]")
    print(" [ ] +++ Analyzing architecture relationships +++")
    for rel in relationships:
        rel_count = component_analysis_data['relationships'].get(rel, 0)

        if num_analyzed_architectures == 0:
            relationship_occurence_percentage = 0.00
        else:
            # What is the percentage of this relationship in the analyzed relationships?
            relationship_occurence_percentage = round(((rel_count / num_analyzed_relationships) * 100), 2)

        # Check for relationship which occur <= lower_percentage_limit
        if relationship_occurence_percentage <= lower_percentage_limit:
            has_issue = True
            print(f" [!] 1-1 relationship '{rel}' does appear in only {relationship_occurence_percentage} % of the analyzed relationships. --> Please check, if this relationship is technically correct, or if you should change one of the components.")
            issues["relationships"].append({"relationship": rel, "percentage": relationship_occurence_percentage})
            invalid_stats['unknown_relationships'][rel] += 1
        else:
            print(f" [ ] 1-1 relationship '{rel}' does appear in {relationship_occurence_percentage} % of the analyzed relationships")

    print(" [ ]")
    print(" [ ] +++ Checking for unknown subgraphs +++")
    unknown_subgraphs = search_unknown_subgraphs(relationships, lower_percentage_limit)
    if unknown_subgraphs:
        has_issue = True
        issues["unknown_subgraphs"].extend(unknown_subgraphs)
    else: 
        print(" [x] No unknown subgraphs found +++")

    # Save architecture result
    print(" [ ]")
    print(" [ ] +++ Analysis complete +++")
    if has_issue:
        print(f" [i] Architecture '{architecture_name}' is marked as problematic.")
        invalid_architectures[architecture_name] = issues
    else:
        print(f" [i] Architecture '{architecture_name}' is marked as valid.")
        valid_architectures.append(architecture_name)

    print(" [ ] ")
    print(" [ ] Update analyzed architectures dictionaries ...")
    print(f" [i] Total valid architectures: {len(valid_architectures)}")
    print(f" [i] Total invalid architectures: {len(invalid_architectures)}")


# Analyzes the components and relationships of the architecture and either adds them to the trainings data or evaluates it by comparing it to the trainings data
def architecture_analysis(component_csv_content, architecture_name, analysis_flag, orig_format):
    df = pd.read_csv(StringIO(component_csv_content))

    # Extract all components
    all_components = set()
    for comp in pd.concat([df['source_component'], df['target_component']]):
        all_components.add(comp)

    # Remove '-<number>' from components
    all_components_without_number = []
    for comp in all_components:
        all_components_without_number.append(simplify_component_name(comp))

    # Remove duplicate elements so only unique components: Java, Java-2 --> Java
    all_components_uniques = list(set(all_components_without_number))

    # Extract all relationships, and remove '-<number>' from components, save additionally the orig_relationship
    relationships = []
    orig_relationships = []
    for _, row in df.iterrows():
        source = simplify_component_name(row['source_component'])
        target = simplify_component_name(row['target_component'])
        relationship = row['relationship']
        relationship_content = (source, target, relationship)
        relationships.append(relationship_content)

        orig_source = row['source_component']
        orig_target = row['target_component']
        orig_relationship_content = (orig_source, orig_target, relationship)
        orig_relationships.append(orig_relationship_content)

    if analysis_flag == 0:
        # Save architecture data in component_analysis_data
        component_analysis_data['total_architectures'] += 1
        for comp in all_components_without_number:
            component_analysis_data['components'][comp] += 1
            component_analysis_data['total_components'] += 1
        for comp in all_components_uniques:
            component_analysis_data['unique_components'][comp] += 1
        for rel in relationships:
            component_analysis_data['relationships'][rel] += 1
            component_analysis_data['total_relationships'] += 1
        print(" [i] Architecture component and relationship data was added to training data")
        
    elif analysis_flag == 1:
        # Evaluate architecture
        analyse_components_and_relationships(orig_format, architecture_name, all_components_uniques, relationships)

# Fetches a CSV file from MinIO and returns its content
def fetch_csv_from_minio(file_name, bucket_name):
    try:
        csv_object = minio_client.get_object(bucket_name, file_name)
        csv_content = csv_object.read().decode('utf-8')
        print(f" [x] File '{file_name}' loaded from MinIO.")
        return csv_content
    except S3Error as e:
        print(f" [!] Error fetching '{file_name}' from MinIO: {str(e)}")
    except Exception as e:
        print(f" [!] Unexpected error fetching file '{file_name}' from MinIO: {str(e)}")
    return None

# Processes incoming message from RabbitMQ
def process_message(channel, method, properties, body):
    try:
        message = json.loads(body)
        print(" ------------------------")
        print(" [x] Received new message")
        print(f" [x] Content: {message}")
        architecture_name = message.get("nameofarchitecture")
        analysis_flag = message.get("analysis")
        component_graph_file = message.get("graphfile")
        orig_format = message.get("orig_format")  # Get the orig_format from the message

        if not architecture_name or not component_graph_file or not orig_format:
            print(f" [!] Invalid message format: {body}")
            channel.basic_ack(delivery_tag=method.delivery_tag)
            return

        # Fetch CSV content from MinIO
        bucket_name = "architectures"
        component_csv_content = fetch_csv_from_minio(component_graph_file, bucket_name)

        # Analyze architecture if file was successfully loaded
        if component_csv_content:
                architecture_analysis(component_csv_content, architecture_name, analysis_flag, orig_format)
        else:
            print(" [!] CSV file could not be loaded. Graph analysis skipped.")

        # Acknowledge the message after processing
        channel.basic_ack(delivery_tag=method.delivery_tag)

        # reset timer
        reset_message_timer()

    except json.JSONDecodeError as e:
        print(f" [!] Error decoding JSON message: {str(e)}")
        channel.basic_ack(delivery_tag=method.delivery_tag)
    except Exception as e:
        print(f" [!] Unexpected error processing message: {str(e)}")
        channel.basic_ack(delivery_tag=method.delivery_tag)

# Starts the RabbitMQ listener
def start_rabbitmq_listener():

    credentials = pika.PlainCredentials(amqpuser, amqppassword)
    connection_params = pika.ConnectionParameters(host=amqpconnection, credentials=credentials)

    while True:
        try:
            # Establish a connection to RabbitMQ
            connection = pika.BlockingConnection(connection_params)
            channel = connection.channel()

            # Declare the queue 'GraphAnalysis' with durable=False to match the existing queue
            channel.queue_declare(queue='GraphAnalysis', durable=False)

            # Start consuming messages
            channel.basic_consume(queue='GraphAnalysis', on_message_callback=process_message)

            print(" [*] Waiting for messages in 'GraphAnalysis' queue.")
            channel.start_consuming()

            #return connection

        except pika.exceptions.AMQPConnectionError as e:
            print(f" [!] Error connecting to RabbitMQ: {str(e)}")
            print(" [!] RabbitMQ is currently not available or is still in the start-up phase. Retrying in 5 seconds...")
            time.sleep(5)
        except Exception as e:
            print(f" [!] Unexpected error starting RabbitMQ listener: {str(e)}")


if __name__ == "__main__":
    start_rabbitmq_listener()
