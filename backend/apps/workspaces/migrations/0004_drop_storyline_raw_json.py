from django.db import migrations


class Migration(migrations.Migration):
    dependencies = [
        ("workspaces", "0003_introcomment"),
    ]

    operations = [
        migrations.RemoveField(
            model_name="storyline",
            name="raw_json",
        ),
    ]
