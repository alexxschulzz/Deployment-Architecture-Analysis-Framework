# Use the official Node.js image as the base image
FROM python:3.12.8-alpine

# Set the working directory in the container
WORKDIR /usr/src/app

# Copy requirements.txt to the working directory
COPY requirements.txt ./

# Install dependencies
RUN pip install -r requirements.txt

# Copy the rest of the application code to the working directory
COPY . .

EXPOSE 10006

# Define the command to run the application
CMD ["python", "-u", "graphAnalysis.py"]
