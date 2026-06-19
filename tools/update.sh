# Update Qadam Flow Docker Instances
echo "Updating Qadam Flow..."
git pull
docker compose pull
docker compose up -d --remove-orphans
echo "Successfully updated Qadam Flow."