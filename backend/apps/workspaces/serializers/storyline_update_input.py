from rest_framework import serializers


class StorylineFileInputSerializer(serializers.Serializer):
    diff_file_path = serializers.CharField(max_length=1024)
    order_index = serializers.IntegerField(min_value=0)
    intro_text = serializers.CharField(required=False, allow_blank=True, default="")


class StorylineUpdateInputSerializer(serializers.Serializer):
    files = StorylineFileInputSerializer(many=True)
