import uuid

from rest_framework import status
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.core.exceptions import ApplicationError
from apps.items.selectors import item_get, item_list
from apps.items.serializers.item_create_input_serializer import ItemCreateInputSerializer
from apps.items.serializers.item_filter_serializer import ItemFilterSerializer
from apps.items.serializers.item_output_serializer import ItemOutputSerializer
from apps.items.serializers.item_update_input_serializer import ItemUpdateInputSerializer
from apps.items.services import item_archive, item_create, item_delete, item_update
from apps.users.models import User


def _get_owner_or_raise(owner_id: int) -> User:
    try:
        return User.objects.get(id=owner_id)
    except User.DoesNotExist as exc:
        raise ApplicationError(
            "Owner not found",
            extra={"owner_id": owner_id},
            status=404,
        ) from exc


class ItemCreateApi(APIView):
    def post(self, request: Request) -> Response:
        serializer = ItemCreateInputSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = dict(serializer.validated_data)
        owner = _get_owner_or_raise(data.pop("owner_id"))
        item = item_create(owner=owner, **data)
        return Response(ItemOutputSerializer(item).data, status=status.HTTP_201_CREATED)


class ItemListApi(APIView):
    def get(self, request: Request) -> Response:
        filter_serializer = ItemFilterSerializer(data=request.query_params)
        filter_serializer.is_valid(raise_exception=True)
        items = item_list(**filter_serializer.validated_data)
        return Response(ItemOutputSerializer(items, many=True).data)


class ItemDetailApi(APIView):
    def get(self, request: Request, item_id: uuid.UUID) -> Response:
        item = item_get(item_id=item_id)
        return Response(ItemOutputSerializer(item).data)


class ItemUpdateApi(APIView):
    def patch(self, request: Request, item_id: uuid.UUID) -> Response:
        item = item_get(item_id=item_id)
        serializer = ItemUpdateInputSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        updated = item_update(item=item, **serializer.validated_data)
        return Response(ItemOutputSerializer(updated).data)


class ItemArchiveApi(APIView):
    def post(self, request: Request, item_id: uuid.UUID) -> Response:
        item = item_get(item_id=item_id)
        archived = item_archive(item=item)
        return Response(ItemOutputSerializer(archived).data)


class ItemDeleteApi(APIView):
    def delete(self, request: Request, item_id: uuid.UUID) -> Response:
        item = item_get(item_id=item_id)
        item_delete(item=item)
        return Response(status=status.HTTP_204_NO_CONTENT)
